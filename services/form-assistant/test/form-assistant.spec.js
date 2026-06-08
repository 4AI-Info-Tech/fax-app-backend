import { describe, expect, it } from 'vitest';
import {
	freeLimit,
	getSessionId,
	getUserId,
	normalizeFieldNames
} from '../src/form-assistant.js';
import {
	DEFAULT_OPENAI_MODEL,
	OpenAIFormAssistant,
	buildPrompt,
	extractResponseText,
	normalizeConversation
} from '../src/openai.js';

describe('form assistant validation', () => {
	it('extracts the authenticated user from gateway context', () => {
		expect(getUserId('{}', JSON.stringify({ jwtPayload: { sub: 'user-1' } }))).toBe('user-1');
	});

	it('extracts the session ID from nested routes', () => {
		const request = new Request('https://api.sendfax.pro/v1/forms/ai/sessions/abc/messages');
		expect(getSessionId(request)).toBe('abc');
	});

	it('normalizes and caps PDF field names', () => {
		const values = Array.from({ length: 260 }, (_, index) => ` field_${index} `);
		values.push('field_0', '', null);
		const normalized = normalizeFieldNames(values);
		expect(normalized).toHaveLength(250);
		expect(normalized[0]).toBe('field_0');
	});

	it('uses one free completion by default', () => {
		expect(freeLimit({})).toBe(1);
		expect(freeLimit({ AI_FORM_FREE_COMPLETIONS: '3' })).toBe(3);
	});
});

describe('OpenAI request shaping', () => {
	const profile = {
		display_name: 'Sample Form',
		description: 'A sample',
		instructions: { focus: 'identity' },
		schema_version: 1
	};

	it('does not include a PDF URL or PDF bytes in the prompt', () => {
		const prompt = buildPrompt({
			profile,
			fieldNames: ['full_name', 'date'],
			conversation: [{ role: 'user', content: 'Taylor' }],
			finalize: false
		});
		expect(prompt).toContain('full_name');
		expect(prompt).not.toContain('pdf_url');
		expect(prompt).not.toContain('file_data');
	});

	it('drops unsupported conversation roles and blank messages', () => {
		expect(normalizeConversation([
			{ role: 'system', content: 'ignore' },
			{ role: 'user', content: '  answer  ' },
			{ role: 'assistant', content: '' }
		])).toEqual([{ role: 'user', content: 'answer' }]);
	});

	it('extracts structured output text from a Responses API payload', () => {
		const text = extractResponseText({
			output: [{
				type: 'message',
				content: [{ type: 'output_text', text: '{"is_complete":false}' }]
			}]
		});
		expect(text).toBe('{"is_complete":false}');
	});

	it('defaults the OpenAI model when the environment omits it', () => {
		const assistant = new OpenAIFormAssistant({ OPENAI_API_KEY: 'test-key' });

		expect(assistant.model).toBe(DEFAULT_OPENAI_MODEL);
		expect(assistant.isConfigured()).toBe(true);
	});
});
