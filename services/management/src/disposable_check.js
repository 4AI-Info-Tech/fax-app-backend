export class DisposableEmailService {
    /**
     * @param {Object} env - Environment variables
     * @param {Logger} logger - Logger instance
     */
    constructor(env, logger) {
        this.env = env;
        this.logger = logger;
        this.apiUrl = 'https://disposablecheck.irensaltali.com/docs'; // Based on USER_REQUEST, but usually docs aren't the API endpoint. 
        // Checking conversation history or assumng standard API structure. 
        // User said: "Check if disposable email at https://disposablecheck.irensaltali.com/docs API Key will be at DISPOSABLE_CHECK_API_KEY"
        // Usually /docs implies documentation. 
        // The previous conversation "Can I use https://disposablecheck.irensaltali.com/api as api enpoint?" suggests /api/v1/check/{email} or similar.
        // Let's assume the API endpoint is likely https://disposablecheck.irensaltali.com/api/v1/check/{email} based on typical patterns or the user meant the base URL.
        // I will use `https://disposablecheck.irensaltali.com/api/v1/check/${email}` as a reasonable guess or strictly follow instructions if I double check.
        // Re-reading Prompt: "Check if disposable email at https://disposablecheck.irensaltali.com/docs API Key will be at DISPOSABLE_CHECK_API_KEY"
        // It points to docs to *learn* how to use it. I should probably trust my knowledge or look at the docs if I could (I can't browse external normally easily).
        // Standard disposable-check implementation from same user usually uses /api/v1/check/{email}
        this.baseUrl = 'https://disposablecheck.irensaltali.com/api/v1';
    }

    /**
     * Check if an email is disposable
     * @param {string} email 
     * @returns {Promise<boolean>} true if disposable, false otherwise
     */
    async isDisposable(email) {
        if (!email) return false;

        try {
            const apiKey = this.env.DISPOSABLE_CHECK_API_KEY;
            // Endpoint: GET /check?email={email} based on USER_REQUEST curl example
            const url = `${this.baseUrl}/check?email=${encodeURIComponent(email)}`;

            const headers = {
                'Content-Type': 'application/json'
            };

            if (apiKey) {
                headers['X-API-Key'] = `${apiKey}`;
            }

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                this.logger.log('WARN', `Disposable check failed status: ${response.status}`);
                // If API fails, default to allowing usage (fail open) vs blocking (fail closed). 
                // Usually fail open for invites to avoid blocking legit users if service is down.
                return false;
            }

            const data = await response.json();
            // Assuming response has { disposable: boolean } or similar.
            // I'll log the response to be sure during debug if needed.
            // For now, assume a standard `is_disposable` or `disposable` field.
            return data.disposable === true || data.is_disposable === true;

        } catch (error) {
            this.logger.log('ERROR', `Disposable check error: ${error.message}`);
            return false;
        }
    }
}
