import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' }
			}
		},
		server: {
			deps: {
				inline: [
					'@supabase/supabase-js',
					'@supabase/postgrest-js',
					'@supabase/storage-js',
					'@supabase/realtime-js',
					'@supabase/gotrue-js'
				]
			}
		}
	}
});
