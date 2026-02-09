/**
 * Database utilities for AdMob service
 */

import { createClient } from '@supabase/supabase-js';

export class DatabaseUtils {
	/**
	 * Get Supabase client
	 */
	static getSupabaseClient(env) {
		const supabaseUrl = env.SUPABASE_URL;
		const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

		if (!supabaseUrl || !supabaseKey) {
			throw new Error('Missing Supabase configuration');
		}

		return createClient(supabaseUrl, supabaseKey);
	}

	/**
	 * Check if a transaction has already been processed (idempotency)
	 */
	static async checkTransactionExists(transactionId, env, logger) {
		try {
			const supabase = this.getSupabaseClient(env);

			const { data, error } = await supabase
				.from('rewarded_video_completions')
				.select('id, completed_at')
				.eq('completion_token', transactionId)
				.single();

			if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
				logger?.log('ERROR', 'Error checking transaction existence', { error: error.message });
				throw error;
			}

			return data;
		} catch (error) {
			logger?.log('ERROR', 'Database error checking transaction', { error: error.message });
			throw error;
		}
	}

	static async getRecentAdCountIn24Hours(userId, env, logger) {
		try {
			const supabase = this.getSupabaseClient(env);
			const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

			const { data: recentAds, error } = await supabase
				.from('rewarded_video_completions')
				.select('id, completed_at')
				.eq('user_id', userId)
				.gte('completed_at', twentyFourHoursAgo);

			if (error) {
				logger?.log('ERROR', 'Error checking 24h ad count', { error: error.message });
				throw error;
			}

			return {
				recentAdCount: recentAds?.length || 0,
				recentAds: recentAds || []
			};
		} catch (error) {
			logger?.log('ERROR', 'Database error checking 24h ad count', { error: error.message });
			throw error;
		}
	}

	static async insertRewardedVideoCompletion(params, env, logger) {
		const { userId, transactionId, adUnit, rewardCredits, rewardItem, adNetwork, timestamp } = params;
		try {
			const supabase = this.getSupabaseClient(env);
			const currentMonth = new Date().toISOString().substring(0, 7);
			const completionData = {
				user_id: userId,
				completion_token: transactionId,
				ad_unit_id: adUnit,
				credits_granted: rewardCredits,
				month_year: currentMonth,
				metadata: {
					ad_network: adNetwork,
					reward_item: rewardItem,
					original_timestamp: timestamp,
					source: 'admob_ssv'
				}
			};

			const { data: completion, error } = await supabase
				.from('rewarded_video_completions')
				.insert(completionData)
				.select()
				.single();

			if (error) {
				if (error.code === '23505') {
					return { duplicate: true, completion: null };
				}
				throw error;
			}

			return { duplicate: false, completion };
		} catch (error) {
			logger?.log('ERROR', 'Database error inserting completion', { error: error.message });
			throw error;
		}
	}

	/**
	 * Get user's monthly rewarded video stats
	 */
	static async getMonthlyStats(userId, env, logger) {
		try {
			const supabase = this.getSupabaseClient(env);
			const currentMonth = new Date().toISOString().substring(0, 7);

			const { data, error } = await supabase
				.from('rewarded_video_completions')
				.select('id')
				.eq('user_id', userId)
				.eq('month_year', currentMonth);

			if (error) {
				logger?.log('ERROR', 'Error getting monthly stats', { error: error.message });
				throw error;
			}

			const completedCount = data?.length || 0;
			return {
				monthYear: currentMonth,
				completedCount,
				remainingCount: Math.max(0, 15 - completedCount),
				canWatch: completedCount < 15
			};

		} catch (error) {
			logger?.log('ERROR', 'Database error getting stats', { error: error.message });
			throw error;
		}
	}
}
