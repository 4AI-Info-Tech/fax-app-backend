/**
 * RevenueCat-backed rewarded ad credit orchestration.
 * Keeps RevenueCat logic separate from pure database helpers.
 */

import { RevenueCatClient } from '../../shared/revenuecat-client.js';
import { DatabaseUtils } from './database.js';

export class RevenueCatRewardService {
	static async deleteCompletionById(completionId, env, logger) {
		try {
			const supabase = DatabaseUtils.getSupabaseClient(env);
			const { error } = await supabase
				.from('rewarded_video_completions')
				.delete()
				.eq('id', completionId);
			return { success: !error, error };
		} catch (error) {
			logger?.log('ERROR', 'Failed to rollback rewarded video completion', { error: error.message });
			return { success: false, error };
		}
	}

	static async insertCreditEvent(params, env, logger) {
		const { userId, transactionId, rewardCredits, currencyCode, adUnit, adNetwork, rewardItem } = params;
		try {
			const supabase = DatabaseUtils.getSupabaseClient(env);
			const { error } = await supabase
				.from('revenuecat_credit_events')
				.insert({
					user_id: userId,
					event_type: 'ad_reward',
					reference_id: transactionId,
					credits: rewardCredits,
					currency_code: currencyCode,
					metadata: {
						source: 'admob_ssv',
						ad_unit_id: adUnit,
						ad_network: adNetwork,
						reward_item: rewardItem
					}
				});
			return { success: !error, error };
		} catch (error) {
			logger?.log('ERROR', 'Failed to insert ad reward credit event', { error: error.message });
			return { success: false, error };
		}
	}

	static async processRewardedVideoCompletion(params, env, logger) {
		const { userId, transactionId, adUnit, rewardAmount, rewardItem, adNetwork, timestamp } = params;
		const rewardCredits = Math.max(1, Math.trunc(Number(rewardAmount) || 1));

		const rcClient = new RevenueCatClient(env, logger);
		if (!rcClient.isConfigured()) {
			throw new Error(rcClient.getConfigurationError() || 'RevenueCat not configured');
		}

		const creditSnapshot = await rcClient.getCreditSnapshot(userId);
		if (creditSnapshot.isSubscriber) {
			logger?.log('WARN', 'Subscribed user attempted to earn rewarded video credits', { userId });
			return {
				success: false,
				reason: 'subscribed_users_cannot_earn'
			};
		}

		const { recentAdCount, recentAds } = await DatabaseUtils.getRecentAdCountIn24Hours(userId, env, logger);
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

		const completionResult = await DatabaseUtils.insertRewardedVideoCompletion({
			userId,
			transactionId,
			adUnit,
			rewardCredits,
			rewardItem,
			adNetwork,
			timestamp
		}, env, logger);

		if (completionResult.duplicate) {
			logger?.log('INFO', 'Duplicate transaction detected', { transactionId });
			return { success: true, duplicate: true };
		}

		const completion = completionResult.completion;
		const freeCurrencyCode = rcClient.freeCurrencyCodes[0];
		const grantResult = await rcClient.grantCredits(userId, freeCurrencyCode, rewardCredits);

		if (!grantResult.success) {
			const rollbackResult = await RevenueCatRewardService.deleteCompletionById(completion.id, env, logger);
			logger?.log('ERROR', 'Failed to grant rewarded video credits in RevenueCat', {
				userId,
				transactionId,
				error: grantResult.error,
				rollbackError: rollbackResult.error?.message || null
			});
			return {
				success: false,
				reason: 'revenuecat_grant_failed',
				completionId: completion.id,
				grantError: grantResult.error,
				rolledBack: rollbackResult.success
			};
		}

		const creditEventResult = await RevenueCatRewardService.insertCreditEvent({
			userId,
			transactionId,
			rewardCredits,
			currencyCode: freeCurrencyCode,
			adUnit,
			adNetwork,
			rewardItem
		}, env, logger);

		if (!creditEventResult.success && creditEventResult.error?.code !== '23505' && creditEventResult.error?.code !== '42P01') {
			logger?.log('WARN', 'Failed to write revenuecat_credit_events audit row for ad reward', {
				userId,
				transactionId,
				error: creditEventResult.error?.message,
				code: creditEventResult.error?.code
			});
		}

		logger?.log('INFO', 'Rewarded video completion recorded and RevenueCat credits granted', {
			userId,
			transactionId,
			completionId: completion.id,
			creditsGranted: rewardCredits,
			currencyCode: freeCurrencyCode,
			recentAdCount: recentAdCount + 1
		});

		return {
			success: true,
			completionId: completion.id,
			creditsGranted: rewardCredits,
			currencyCode: freeCurrencyCode,
			adsWatchedIn24h: recentAdCount + 1,
			adsRemainingIn24h: 3 - (recentAdCount + 1)
		};
	}
}
