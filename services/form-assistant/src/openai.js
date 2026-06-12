const RESPONSE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		assistant_message: { type: 'string' },
		next_question: { type: ['string', 'null'] },
		target_field_name: { type: ['string', 'null'] },
		is_complete: { type: 'boolean' },
		field_values: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					field_name: { type: 'string' },
					value: { type: 'string' },
					confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
				},
				required: ['field_name', 'value', 'confidence']
			}
		},
		field_states: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					field_name: { type: 'string' },
					state: {
						type: 'string',
						enum: ['filled', 'left_blank_by_user', 'unknown', 'needs_review', 'missing']
					},
					review_note: { type: ['string', 'null'] }
				},
				required: ['field_name', 'state', 'review_note']
			}
		},
		missing_fields: {
			type: 'array',
			items: { type: 'string' }
		},
		review_notes: {
			type: 'array',
			items: { type: 'string' }
		}
	},
	required: [
		'assistant_message',
		'next_question',
		'target_field_name',
		'is_complete',
		'field_values',
		'field_states',
		'missing_fields',
		'review_notes'
	]
};

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const ALLOWED_ACTIONS = new Set(['answer', 'leave_blank', 'unknown']);

function normalizeConversation(conversation) {
	if (!Array.isArray(conversation)) return [];

	return conversation
		.filter((message) => (
			message &&
			['assistant', 'user'].includes(message.role) &&
			typeof message.content === 'string'
		))
		.slice(-30)
		.map((message) => {
			const normalized = {
				role: message.role,
				content: message.content.trim().slice(0, 4000)
			};
			if (ALLOWED_ACTIONS.has(message.action)) {
				normalized.action = message.action;
			}
			if (typeof message.target_field_name === 'string' && message.target_field_name.trim()) {
				normalized.target_field_name = message.target_field_name.trim().slice(0, 250);
			}
			return normalized;
		})
		.filter((message) => message.content.length > 0);
}

function extractResponseText(payload) {
	for (const item of payload?.output || []) {
		if (item?.type !== 'message') continue;
		for (const content of item.content || []) {
			if (content?.type === 'output_text' && typeof content.text === 'string') {
				return content.text;
			}
		}
	}
	return null;
}

function normalizeFieldMetadata(fieldMetadata, fieldNames) {
	const safeFields = [...new Set(fieldNames)]
		.filter((name) => typeof name === 'string' && name.trim())
		.slice(0, 250);
	const sourceByName = new Map();

	if (Array.isArray(fieldMetadata)) {
		for (const field of fieldMetadata) {
			const fieldName = field?.field_name;
			if (typeof fieldName !== 'string' || !fieldName.trim()) continue;
			sourceByName.set(fieldName.trim(), field);
		}
	}

	return safeFields.map((fieldName, index) => {
		const source = sourceByName.get(fieldName) || {};
		const pageIndex = Number(source.page_index);
		const displayOrder = Number(source.display_order);
		const currentValue = typeof source.current_value === 'string'
			? source.current_value.trim().slice(0, 500)
			: '';

		return {
			field_name: fieldName,
			page_index: Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null,
			display_order: Number.isInteger(displayOrder) && displayOrder >= 0 ? displayOrder : index,
			is_required: source.is_required === true,
			current_value: currentValue || null
		};
	});
}

function buildPrompt({ profile, fieldNames, fieldMetadata = [], conversation, finalize }) {
	const safeFields = [...new Set(fieldNames)]
		.filter((name) => typeof name === 'string' && name.trim())
		.slice(0, 250);

	return JSON.stringify({
		task: finalize ? 'finalize_form_fields' : 'continue_form_interview',
		form: {
			title: profile.display_name,
			description: profile.description || '',
			profile_instructions: profile.instructions || {},
			schema_version: profile.schema_version
		},
		pdf_field_names: safeFields,
		pdf_fields: normalizeFieldMetadata(fieldMetadata, safeFields),
		conversation: normalizeConversation(conversation),
		rules: [
			'Ask one concise question at a time unless finalizing.',
			'Only return field names from pdf_field_names.',
			'Set target_field_name to the single PDF field your next question is trying to fill, or null when finalizing/reviewing.',
			'Conversation messages may include action=answer, action=leave_blank, or action=unknown with target_field_name.',
			'When action=leave_blank, mark that target field with field_states state left_blank_by_user and do not ask for it again unless it is required and final review needs a warning.',
			'When action=unknown, mark that target field unknown and keep it in missing_fields until the user later supplies a value.',
			'Preserve previously mapped values and current_value entries unless the user clearly corrects or blanks that same field.',
			'Never invent facts, signatures, identifiers, dates, or consent.',
			'Do not provide legal, tax, medical, or filing advice.',
			'Use an empty field_values array when no field can be filled confidently.',
			'Use field_values with an empty value only when the user explicitly asked to leave that exact field blank.',
			'Mark uncertain mappings low confidence and explain them in review_notes.',
			'If an answer could map to multiple fields, ask a clarifying question instead of guessing.',
			'The user must review every value before saving, printing, or faxing.'
		]
	});
}

export class OpenAIFormAssistant {
	constructor(env) {
		this.apiKey = env.OPENAI_API_KEY || '';
		this.model = env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
		this.baseUrl = (env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
	}

	isConfigured() {
		return Boolean(this.apiKey);
	}

	async generate({ profile, fieldNames, fieldMetadata = [], conversation = [], finalize = false }) {
		if (!this.isConfigured()) {
			throw new Error('OPENAI_API_KEY is required');
		}

		const response = await fetch(`${this.baseUrl}/responses`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: this.model,
				store: false,
				instructions:
					'You are a privacy-conscious form filling assistant. Convert only user-provided facts into exact PDF field values. Return structured data only.',
				input: buildPrompt({ profile, fieldNames, fieldMetadata, conversation, finalize }),
				text: {
					format: {
						type: 'json_schema',
						name: 'form_assistant_turn',
						strict: true,
						schema: RESPONSE_SCHEMA
					}
				}
			})
		});

		const raw = await response.text();
		let payload = {};
		if (raw) {
			try {
				payload = JSON.parse(raw);
			} catch {
				throw new Error(`OpenAI returned invalid JSON (${response.status})`);
			}
		}

		if (!response.ok) {
			const message = payload?.error?.message || `OpenAI request failed (${response.status})`;
			throw new Error(message);
		}

		const outputText = extractResponseText(payload);
		if (!outputText) {
			throw new Error('OpenAI response did not contain structured output');
		}

		try {
			return JSON.parse(outputText);
		} catch {
			throw new Error('OpenAI structured output could not be decoded');
		}
	}
}

export {
	DEFAULT_OPENAI_MODEL,
	RESPONSE_SCHEMA,
	buildPrompt,
	extractResponseText,
	normalizeConversation,
	normalizeFieldMetadata
};
