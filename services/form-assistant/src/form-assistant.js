import { WorkerEntrypoint } from 'cloudflare:workers';
import { RevenueCatClient } from '../../shared/revenuecat-client.js';
import { FormAssistantDatabase } from './database.js';
import { OpenAIFormAssistant, normalizeConversation } from './openai.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function parseObject(value) {
	if (!value) return {};
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

function getUserId(callerEnv, sagContext) {
	const caller = parseObject(callerEnv);
	const context = parseObject(sagContext);
	return context.jwtPayload?.sub || context.jwtPayload?.user_id || caller.userId || null;
}

function getSessionId(request) {
	const parts = new URL(request.url).pathname.split('/').filter(Boolean);
	const sessionsIndex = parts.indexOf('sessions');
	return sessionsIndex >= 0 ? parts[sessionsIndex + 1] : null;
}

function normalizeFieldNames(fields) {
	if (!Array.isArray(fields)) return [];
	return [...new Set(fields)]
		.filter((field) => typeof field === 'string')
		.map((field) => field.trim())
		.filter(Boolean)
		.slice(0, 250);
}

function freeLimit(env) {
	const parsed = Number(env.AI_FORM_FREE_COMPLETIONS || 1);
	return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 1;
}

async function getSubscriberStatus(userId, env, callerEnv) {
	const mergedEnv = { ...parseObject(callerEnv), ...env };
	const revenueCat = new RevenueCatClient(mergedEnv);
	if (!revenueCat.isConfigured()) {
		throw new Error(revenueCat.getConfigurationError());
	}
	const snapshot = await revenueCat.getCreditSnapshot(userId);
	return snapshot.isSubscriber === true;
}

export default class extends WorkerEntrypoint {
	async fetch() {
		return json({ service: 'form-assistant', status: 'healthy' });
	}

	async health() {
		return json({ service: 'form-assistant', status: 'healthy', timestamp: new Date().toISOString() });
	}

	async profiles() {
		try {
			const database = new FormAssistantDatabase(this.env);
			const profiles = await database.listProfiles();
			return json({ profiles });
		} catch (error) {
			console.error('Form assistant profiles failed', error);
			return json({ error: 'Unable to load AI-ready forms' }, 500);
		}
	}

	async createSession(request, callerEnv = '{}', sagContext = '{}') {
		const userId = getUserId(callerEnv, sagContext);
		if (!userId) return json({ error: 'Authentication required' }, 401);

		try {
			const body = await request.json();
			const formId = body?.form_id;
			const fieldNames = normalizeFieldNames(body?.field_names);
			if (!UUID_REGEX.test(formId || '') || fieldNames.length === 0) {
				return json({ error: 'form_id and at least one field_name are required' }, 400);
			}

			const database = new FormAssistantDatabase(this.env);
			const profile = await database.getProfile(formId);
			if (!profile) return json({ error: 'AI assistance is not enabled for this form' }, 404);

			const isSubscriber = await getSubscriberStatus(userId, this.env, callerEnv);
			if (!isSubscriber) {
				const usage = await database.getUsage(userId);
				if (usage.completed_count >= freeLimit(this.env)) {
					return json({
						error: 'AI form filling requires Pro after the free completion',
						code: 'ai_form_pro_required',
						completed_count: usage.completed_count
					}, 402);
				}
			}

			const session = await database.createSession({ userId, profile, fieldNames });
			const assistant = new OpenAIFormAssistant(this.env);
			const turn = await assistant.generate({ profile, fieldNames, conversation: [] });
			await database.incrementCalls(session.id, userId);

			return json({
				session_id: session.id,
				form_id: session.form_id,
				is_subscriber: isSubscriber,
				...turn
			}, 201);
		} catch (error) {
			console.error('Form assistant session creation failed', error);
			return json({ error: 'Unable to start AI form filling' }, 500);
		}
	}

	async message(request, callerEnv = '{}', sagContext = '{}') {
		return this.generateTurn(request, callerEnv, sagContext, false);
	}

	async finalize(request, callerEnv = '{}', sagContext = '{}') {
		return this.generateTurn(request, callerEnv, sagContext, true);
	}

	async generateTurn(request, callerEnv, sagContext, finalize) {
		const userId = getUserId(callerEnv, sagContext);
		if (!userId) return json({ error: 'Authentication required' }, 401);

		const sessionId = getSessionId(request);
		if (!UUID_REGEX.test(sessionId || '')) return json({ error: 'Invalid session ID' }, 400);

		try {
			const body = await request.json();
			const conversation = normalizeConversation(body?.conversation);
			if (conversation.length === 0) {
				return json({ error: 'conversation is required' }, 400);
			}

			const database = new FormAssistantDatabase(this.env);
			const session = await database.getSession(sessionId, userId);
			if (!session) return json({ error: 'Session not found' }, 404);
			if (session.status === 'completed') return json({ error: 'Session is already completed' }, 409);

			const assistant = new OpenAIFormAssistant(this.env);
			const turn = await assistant.generate({
				profile: session.profile,
				fieldNames: session.field_names,
				conversation,
				finalize
			});
			await database.incrementCalls(session.id, userId);

			if (!finalize) return json({ session_id: session.id, ...turn });

			const isSubscriber = await getSubscriberStatus(userId, this.env, callerEnv);
			const completion = await database.completeSession({
				sessionId: session.id,
				userId,
				isSubscriber,
				freeLimit: freeLimit(this.env)
			});

			if (!completion?.allowed) {
				return json({
					error: 'AI form filling requires Pro after the free completion',
					code: 'ai_form_pro_required'
				}, 402);
			}

			return json({
				session_id: session.id,
				is_subscriber: isSubscriber,
				free_completions_used: completion.completed_count,
				...turn,
				is_complete: true,
				next_question: null
			});
		} catch (error) {
			console.error(`Form assistant ${finalize ? 'finalize' : 'message'} failed`, error);
			return json({ error: `Unable to ${finalize ? 'complete' : 'continue'} AI form filling` }, 500);
		}
	}
}

export { freeLimit, getSessionId, getUserId, normalizeFieldNames };
