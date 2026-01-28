import inviteTemplate from './email/invite.html';

export class EmailService {
    /**
     * @param {Object} env - Environment variables
     * @param {Logger} logger - Logger instance
     */
    constructor(env, logger) {
        this.env = env;
        this.logger = logger;
    }

    /**
     * Send an invite email
     * @param {string} toEmail 
     * @param {string} inviterEmail
     */
    async sendInviteEmail(toEmail, inviterEmail) {
        // Replace placeholders
        const htmlBody = inviteTemplate.replace('{{inviter_email}}', inviterEmail);

        try {
            const resendApiKey = this.env.RESEND_API_KEY;

            if (!resendApiKey) {
                this.logger.log('ERROR', 'RESEND_API_KEY is missing');
                throw new Error('Email configuration error');
            }

            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${resendApiKey}`
                },
                body: JSON.stringify({
                    from: 'Send Fax Pro <noreply@sendfax.pro>',
                    to: [toEmail],
                    subject: "You're invited to Send Fax Pro",
                    html: htmlBody,
                    text: `${inviterEmail} invited you to try Send Fax Pro. Download it here: https://apps.apple.com/app/send-fax-pro-secure-faxing/id6748022728`
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.log('ERROR', `Resend API Failed: ${response.status} - ${errorText}`);
                throw new Error(`Failed to send email: ${response.status}`);
            }

            const data = await response.json();
            this.logger.log('INFO', `Invite email sent to ${toEmail} via Resend`, { id: data.id });
            return true;

        } catch (error) {
            this.logger.log('ERROR', `Email sending error: ${error.message}`);
            throw error;
        }
    }
}
