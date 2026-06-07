import { createClient } from '@supabase/supabase-js';

export class FormAssistantDatabase {
	constructor(env) {
		if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
			throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
		}
		this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	}

	async listProfiles() {
		const { data, error } = await this.client
			.from('ai_form_profiles')
			.select('id, form_id, display_name, description, schema_version, sort_order')
			.eq('is_enabled', true)
			.order('sort_order', { ascending: true })
			.order('display_name', { ascending: true });

		if (error) throw error;
		return data || [];
	}

	async getProfile(formId) {
		const { data, error } = await this.client
			.from('ai_form_profiles')
			.select('id, form_id, display_name, description, instructions, schema_version')
			.eq('form_id', formId)
			.eq('is_enabled', true)
			.maybeSingle();

		if (error) throw error;
		return data;
	}

	async createSession({ userId, profile, fieldNames }) {
		const { data, error } = await this.client
			.from('ai_form_sessions')
			.insert({
				user_id: userId,
				profile_id: profile.id,
				form_id: profile.form_id,
				field_names: fieldNames,
				status: 'started'
			})
			.select('id, form_id, status, created_at')
			.single();

		if (error) throw error;
		return data;
	}

	async getSession(sessionId, userId) {
		const { data, error } = await this.client
			.from('ai_form_sessions')
			.select(`
				id,
				form_id,
				field_names,
				status,
				ai_calls,
				ai_form_profiles (
					id,
					form_id,
					display_name,
					description,
					instructions,
					schema_version
				)
			`)
			.eq('id', sessionId)
			.eq('user_id', userId)
			.maybeSingle();

		if (error) throw error;
		if (!data) return null;
		data.profile = data.ai_form_profiles;
		delete data.ai_form_profiles;
		return data;
	}

	async incrementCalls(sessionId, userId) {
		const { error } = await this.client.rpc('increment_ai_form_session_calls', {
			p_session_id: sessionId,
			p_user_id: userId
		});
		if (error) throw error;
	}

	async getUsage(userId) {
		const { data, error } = await this.client
			.from('ai_form_usage')
			.select('completed_count, last_completed_at')
			.eq('user_id', userId)
			.maybeSingle();

		if (error) throw error;
		return data || { completed_count: 0, last_completed_at: null };
	}

	async completeSession({ sessionId, userId, isSubscriber, freeLimit }) {
		const { data, error } = await this.client.rpc('complete_ai_form_session', {
			p_session_id: sessionId,
			p_user_id: userId,
			p_is_subscriber: isSubscriber,
			p_free_limit: freeLimit
		});

		if (error) throw error;
		return Array.isArray(data) ? data[0] : data;
	}
}
