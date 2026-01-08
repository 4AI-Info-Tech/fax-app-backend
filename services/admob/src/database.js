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
	 * Record rewarded video completion and grant pages
	 */
	static async recordRewardedVideoCompletion(params, env, logger) {
		const { userId, transactionId, adUnit, rewardAmount, rewardItem, adNetwork, timestamp } = params;
		
		try {
			const supabase = this.getSupabaseClient(env);
			
			// Get current month in YYYY-MM format
			const currentMonth = new Date().toISOString().substring(0, 7);
			
			// Check monthly cap (15 completions per month)
			const { data: monthlyCount, error: countError } = await supabase
				.from('rewarded_video_completions')
				.select('id', { count: 'exact' })
				.eq('user_id', userId)
				.eq('month_year', currentMonth);
			
			if (countError) {
				logger?.log('ERROR', 'Error checking monthly count', { error: countError.message });
				throw countError;
			}
			
			const completionCount = monthlyCount?.length || 0;
			if (completionCount >= 15) {
				logger?.log('WARN', 'User has reached monthly cap', { userId, completionCount });
				return { 
					success: false, 
					reason: 'monthly_cap_reached',
					completionCount 
				};
			}
			
			// Insert completion record
			const insertData = {
				user_id: userId,
				completion_token: transactionId,
				ad_unit_id: adUnit,
				pages_granted: rewardAmount || 1,
				month_year: currentMonth
			};
			
			// Add metadata if the column exists (added in migration 20250144000000)
			try {
				insertData.metadata = {
					ad_network: adNetwork,
					reward_item: rewardItem,
					original_timestamp: timestamp,
					source: 'admob_ssv'
				};
			} catch (e) {
				// Metadata column might not exist yet
				logger?.log('DEBUG', 'Metadata column not available, skipping');
			}
			
			const { data: completion, error: insertError } = await supabase
				.from('rewarded_video_completions')
				.insert(insertData)
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
			
			// Grant credits using the stored procedure
			const { error: grantError } = await supabase.rpc('grant_credits', {
				p_user_id: userId,
				p_amount: rewardAmount || 1,
				p_source: 'rewarded_video',
				p_reference_id: completion.id,
				p_metadata: {
					transaction_id: transactionId,
					ad_unit_id: adUnit,
					ad_network: adNetwork,
					source: 'admob_ssv'
				}
			});
			
			if (grantError) {
				logger?.log('ERROR', 'Error granting credits', { error: grantError.message });
				// Don't throw - completion was recorded, pages grant failed
				return { 
					success: true, 
					completionId: completion.id,
					creditsGranted: false,
					grantError: grantError.message
				};
			}
			
			logger?.log('INFO', 'Rewarded video completion recorded and pages granted', {
				userId,
				transactionId,
				completionId: completion.id,
				pagesGranted: rewardAmount || 1
			});
			
			return { 
				success: true, 
				completionId: completion.id,
				pagesGranted: rewardAmount || 1
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
