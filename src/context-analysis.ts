/**
 * LLM-driven context analysis and filtering suggestions.
 * 
 * This module provides AI-powered insights for managing conversation context,
 * including redundant entry detection and intelligent filtering recommendations.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TurnUnit } from "./turn-units.ts";
import { toLLMMemoryEntry, exportToLLMJSON } from "./llm-export.ts";

/**
 * Result of LLM context analysis.
 */
export interface ContextAnalysis {
	/** Entries identified as potentially redundant */
	redundantEntries: Array<{
		entry: TurnUnit;
		reason: string;
		confidence: number; // 0-100
		replacement?: string; // Suggested compressed content
	}>;
	/** Entries that could be compressed */
	compressibleEntries: Array<{
		entry: TurnUnit;
		suggestedCompression: string;
		expectedSavings: number; // Estimated token savings
	}>;
	/** Summary of the analysis */
	summary: string;
}

/**
 * Analyze conversation context for redundancy and optimization opportunities.
 */
export async function analyzeContext(
	units: TurnUnit[],
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<ContextAnalysis> {
	// Convert units to LLM-friendly format
	const entries = units.map(unit => toLLMMemoryEntry(unit));
	const jsonOutput = exportToLLMJSON(entries);
	
	// Create analysis prompt
	const prompt = `You are analyzing an AI coding agent's conversation history to identify redundant or outdated information that could be optimized.

Entries to analyze:
${jsonOutput}

Analyze for:
1. Redundant information - repeated context, overlapping details, duplicate instructions
2. Outdated information - old solutions, superseded decisions, obsolete file states
3. Compressible content - verbose descriptions that could be summarized without losing meaning

For each issue found, provide:
- Entry ID and reason
- Confidence score (0-100)
- Optional suggested replacement (compressed version)

Output your analysis in this JSON format:
{
  "redundant": [
    {
      "entryId": "id",
      "reason": "description",
      "confidence": 0-100,
      "replacement": "suggested compressed content (optional)"
    }
  ],
  "compressible": [
    {
      "entryId": "id",
      "suggestedCompression": "brief summary",
      "expectedSavings": estimated_token_count
    }
  ],
  "summary": "brief analysis summary"
}`;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		if (!auth.apiKey) throw new Error(`No API key configured for ${model.provider}`);

		const response = await complete(
			model,
			{
				systemPrompt: "You are a context optimization assistant. Output only valid JSON, no additional text.",
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				maxTokens: 2048,
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);

		const text = response.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		// Parse JSON response
		let analysis;
		try {
			analysis = JSON.parse(text) as ContextAnalysis;
		} catch {
			// Fallback: if JSON parsing fails, create a basic analysis
			analysis = {
				redundantEntries: [],
				compressibleEntries: units
					.filter(u => u.tokenEstimate > 500 && u.metadata.importanceScore < 70)
					.map(u => ({
						entry: u,
						suggestedCompression: `Compressed summary of ${u.metadata.heading} (${u.tokenEstimate} → ~500 tok)`,
						expectedSavings: u.tokenEstimate - 500,
					})),
				summary: "Basic analysis completed. Consider compressing large, low-importance entries.",
			};
		}

		return analysis;
	} catch (error) {
		// Fallback to rule-based analysis
		console.error("Context analysis failed:", error);
		return {
			redundantEntries: [],
			compressibleEntries: units
				.filter(u => u.tokenEstimate > 500 && u.metadata.importanceScore < 70)
				.map(u => ({
					entry: u,
					suggestedCompression: `Compressed summary of ${u.metadata.heading}`,
					expectedSavings: Math.floor(u.tokenEstimate * 0.5),
				})),
			summary: "AI analysis unavailable. Using rule-based optimization suggestions.",
		};
	}
}

/**
 * Generate a markdown report of context analysis results.
 */
export function generateAnalysisReport(analysis: ContextAnalysis): string {
	const lines: string[] = [];
	
	lines.push("# Context Analysis Report");
	lines.push("");
	lines.push(`**Summary**: ${analysis.summary}`);
	lines.push("");
	
	if (analysis.redundantEntries.length > 0) {
		lines.push("## Redundant Entries");
		lines.push("");
		analysis.redundantEntries.forEach((entry, idx) => {
			lines.push(`### ${idx + 1}. ${entry.entry.metadata.heading}`);
			lines.push(`- **ID**: ${entry.entry.groupId}`);
			lines.push(`- **Reason**: ${entry.reason}`);
			lines.push(`- **Confidence**: ${entry.confidence}%`);
			if (entry.replacement) {
				lines.push(`- **Replacement**: ${entry.replacement}`);
			}
			lines.push("");
		});
	}
	
	if (analysis.compressibleEntries.length > 0) {
		lines.push("## Compressible Entries");
		lines.push("");
		analysis.compressibleEntries.forEach((entry, idx) => {
			lines.push(`### ${idx + 1}. ${entry.entry.metadata.heading}`);
			lines.push(`- **ID**: ${entry.entry.groupId}`);
			lines.push(`- **Current Size**: ${entry.entry.tokenEstimate} tokens`);
			lines.push(`- **Expected Savings**: ${entry.expectedSavings} tokens`);
			lines.push(`- **Suggested Compression**: ${entry.suggestedCompression}`);
			lines.push("");
		});
	}
	
	return lines.join("\n");
}
