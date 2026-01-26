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

	/**
	 * Record rewarded video completion and grant free credits
	 * - Checks 24-hour sliding window limit (max 3 ads)
	 * - Inserts directly into free_credits table with type='ad'
	 */
	static async recordRewardedVideoCompletion(params, env, logger) {
		const { userId, transactionId, adUnit, rewardAmount, rewardItem, adNetwork, timestamp } = params;

		try {
			const supabase = this.getSupabaseClient(env);

			// Check 24-hour sliding window cap (3 ads max in last 24 hours)
			const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

			const { data: recentAds, error: recentError } = await supabase
				.from('free_credits')
				.select('id, created_at')
				.eq('user_id', userId)
				.eq('type', 'ad')
				.gte('created_at', twentyFourHoursAgo);

			if (recentError) {
				logger?.log('ERROR', 'Error checking 24h ad count', { error: recentError.message });
				throw recentError;
			}

			const recentAdCount = recentAds?.length || 0;
			if (recentAdCount >= 3) {
				logger?.log('WARN', 'User has reached 24-hour ad limit', {
					userId,
					recentAdCount,
					oldestAdInWindow: recentAds[0]?.created_at
				});
				return {
					success: false,
					reason: 'daily_ad_limit_reached',
					recentAdCount,
					limitResetInfo: 'Limit resets on a 24-hour sliding window basis'
				};
			}

			// Get current month in YYYY-MM format for completion tracking
			const currentMonth = new Date().toISOString().substring(0, 7);

			// Insert completion record (for tracking/idempotency)
			const completionData = {
				user_id: userId,
				completion_token: transactionId,
				ad_unit_id: adUnit,
				credits_granted: rewardAmount || 1,
				month_year: currentMonth,
				metadata: {
					ad_network: adNetwork,
					reward_item: rewardItem,
					original_timestamp: timestamp,
					source: 'admob_ssv'
				}
			};

			const { data: completion, error: insertError } = await supabase
				.from('rewarded_video_completions')
				.insert(completionData)
				.select()
				.single();

			if (insertError) {
				// Check for duplicate key error
				if (insertError.code === '23505') {
					logger?.log('INFO', 'Duplicate transaction detected', { transactionId });
					return { success: true, duplicate: true };
				}
				logger?.log('ERROR', 'Error inserting completion', { error: insertError.message });
				throw insertError;
			}

			// Calculate expiry date (30 days from now)
			const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

			// Insert into free_credits table
			const freeCreditData = {
				user_id: userId,
				type: 'ad',
				credit_limit: rewardAmount || 1,
				credits_used: 0,
				expires_at: expiresAt,
				reference_id: completion.id,
				is_active: true,
				metadata: {
					transaction_id: transactionId,
					ad_unit_id: adUnit,
					ad_network: adNetwork,
					reward_item: rewardItem,
					source: 'admob_ssv',
					completion_id: completion.id
				}
			};

			const { data: freeCredit, error: freeCreditError } = await supabase
				.from('free_credits')
				.insert(freeCreditData)
				.select()
				.single();

			if (freeCreditError) {
				logger?.log('ERROR', 'Error inserting free credit', { error: freeCreditError.message });
				// Don't throw - completion was recorded, credit grant failed
				return {
					success: true,
					completionId: completion.id,
					creditsGranted: false,
					grantError: freeCreditError.message
				};
			}

			logger?.log('INFO', 'Rewarded video completion recorded and free credits granted', {
				userId,
				transactionId,
				completionId: completion.id,
				freeCreditId: freeCredit.id,
				creditsGranted: rewardAmount || 1,
				expiresAt,
				recentAdCount: recentAdCount + 1
			});

			return {
				success: true,
				completionId: completion.id,
				freeCreditId: freeCredit.id,
				creditsGranted: rewardAmount || 1,
				expiresAt,
				adsWatchedIn24h: recentAdCount + 1,
				adsRemainingIn24h: 3 - (recentAdCount + 1)
			};

		} catch (error) {
			logger?.log('ERROR', 'Database error recording completion', { error: error.message });
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
