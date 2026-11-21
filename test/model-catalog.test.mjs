import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanModelBadgeLabel,
  extractThinkingEffort,
  mapThinkingLevel,
  mergeModelCatalogSnapshots,
  parseAvailableModelsCatalog,
  stripModelFamilySlug,
  stripModelSuffixAndVendor,
} from '../lib/model-catalog.mjs';

describe('antigravity-sidecar-kit/models dynamic model catalog', () => {
  it('maps numeric and enum ThinkingLevel values plus Minimal..Max string fallbacks', () => {
    assert.equal(mapThinkingLevel(1), 'Low');
    assert.equal(mapThinkingLevel(2), 'Medium');
    assert.equal(mapThinkingLevel(3), 'High');
    assert.equal(mapThinkingLevel(4), 'Minimal');
    assert.equal(mapThinkingLevel(5), 'XHigh');
    assert.equal(mapThinkingLevel(100), 'XHigh');
    assert.equal(mapThinkingLevel(99), '');
    assert.equal(mapThinkingLevel('THINKING_LEVEL_MINIMAL'), 'Minimal');
    assert.equal(mapThinkingLevel('EXTRA_HIGH'), 'XHigh');
    assert.equal(mapThinkingLevel(100, 'Claude Titan 6.0 (Max)', 'claude-titan-6-0-max'), 'Max');

    assert.equal(extractThinkingEffort('Gemini 5 Xenon (Minimal)', 'gemini-5-xenon-minimal'), 'Minimal');
    assert.equal(extractThinkingEffort('', 'gemini-4-neon-xhigh'), 'XHigh');
    assert.equal(cleanModelBadgeLabel('', 'gemini-5-xenon-minimal'), 'Gemini 5 Xenon (Minimal)');
    assert.equal(stripModelFamilySlug('gemini-5-helium-tiered-xhigh'), 'gemini-5-helium');

    // Linear-time hostile input guard against polynomial regex backtracking
    const t0 = performance.now();
    assert.equal(extractThinkingEffort(`${' '.repeat(50_000)}(Nope)`, 'x'), '');
    assert.equal(stripModelSuffixAndVendor(`Gemini ${' '.repeat(50_000)}(Nope)`), `${' '.repeat(0)}(Nope)`);
    assert.equal(stripModelFamilySlug(`gemini${'-tiered-'.repeat(10_000)}x`), 'gemini');
    assert.ok(performance.now() - t0 < 200);
  });

  it('maps Go internal ThinkingLevel 7 and Orchestrator (Neon) fallback to XHigh', () => {
    assert.equal(mapThinkingLevel(7), 'XHigh');
    assert.equal(mapThinkingLevel(7, 'Gemini 4 Neon', 'gemini-4-neon-xhigh'), 'XHigh');
    assert.equal(extractThinkingEffort('Orchestrator (Neon)', 'gemini-pro-orchestrator-neon'), 'XHigh');
    assert.equal(extractThinkingEffort('Orchestrator (Carbon)', 'gemini-pro-orchestrator'), 'High');
  });

  it('auto-detects flagship vs fast families, checkpointer ceilings, and hidden tiered models for arbitrary future codenames', () => {
    const availResponse = {
      response: {
        defaultAgentModelId: 'gemini-5-xenon-high',
        tieredModelIds: {
          flashLite: ['gemini-4.5-flash-lite'],
          flash: ['gemini-5-helium-tiered-high', 'gemini-3.8-flash-tiered'],
          pro: ['gemini-5-helium-tiered-xhigh'],
        },
        agentModelSorts: [
          {
            displayName: 'Recommended',
            groups: [
              {
                modelIds: [
                  'gemini-5-xenon-high',
                  'gemini-5-xenon-xhigh',
                  'gemini-5-helium-high',
                  'gemini-5-helium-low',
                  'gemini-pro-orchestrator-xenon',
                  'claude-titan-6-0-max',
                  'claude-sonnet-5-5-medium',
                  'gpt-oss-120b-medium',
                ],
              },
            ],
          },
        ],
        models: {
          'gemini-5-xenon-xhigh': {
            model: 'MODEL_PLACEHOLDER_M910',
            displayName: 'Gemini 5 Xenon (XHigh)',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            thinkingLevel: 100,
            maxTokens: 2097152,
            maxOutputTokens: 262144,
            recommended: true,
            modelExperiments: {
              experiments: {
                CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                  stringValue: JSON.stringify({ max_token_limit: '768000' }),
                },
                huge_prompt_blob: { stringValue: 'X'.repeat(50000) },
              },
            },
          },
          'gemini-5-xenon-high': {
            model: 'MODEL_PLACEHOLDER_M911',
            displayName: 'Gemini 5 Xenon (High)',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            thinkingLevel: 3,
            maxTokens: 2097152,
            maxOutputTokens: 262144,
            recommended: true,
            modelExperiments: {
              experiments: {
                CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                  stringValue: JSON.stringify({ max_token_limit: '768000' }),
                },
              },
            },
          },
          'gemini-5-helium-high': {
            model: 'MODEL_PLACEHOLDER_M920',
            displayName: 'Gemini 5 Helium (High)',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            thinkingLevel: 3,
            maxTokens: 1048576,
            maxOutputTokens: 262144,
            recommended: true,
          },
          'gemini-5-helium-low': {
            model: 'MODEL_PLACEHOLDER_M921',
            displayName: 'Gemini 5 Helium (Low)',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            thinkingLevel: 1,
            maxTokens: 1048576,
            maxOutputTokens: 262144,
            recommended: true,
          },
          'gemini-5-helium-tiered-high': {
            model: 'MODEL_PLACEHOLDER_M922',
            displayName: 'Gemini 5 Helium (High)',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            thinkingLevel: 3,
            maxTokens: 1048576,
            maxOutputTokens: 262144,
            recommended: true,
          },
          'gemini-pro-orchestrator-xenon': {
            model: 'MODEL_PLACEHOLDER_M930',
            displayName: 'Orchestrator (Xenon)',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            thinkingLevel: 100,
            maxTokens: 2097152,
            maxOutputTokens: 262144,
            recommended: true,
            modelExperiments: {
              experiments: {
                CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                  stringValue: JSON.stringify({ max_token_limit: '512000' }),
                },
              },
            },
          },
          'claude-titan-6-0-max': {
            model: 'MODEL_PLACEHOLDER_M940',
            displayName: 'Claude Titan 6.0 (Max)',
            modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
            apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
            thinkingLevel: 100,
            maxTokens: 1000000,
            maxOutputTokens: 128000,
            recommended: true,
            modelExperiments: {
              experiments: {
                CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                  stringValue: JSON.stringify({ max_token_limit: '256000' }),
                },
              },
            },
          },
          'claude-sonnet-5-5-medium': {
            model: 'MODEL_PLACEHOLDER_M404',
            displayName: 'Claude Sonnet 5.5 (Medium)',
            modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
            apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
            thinkingLevel: 2,
            maxTokens: 1000000,
            maxOutputTokens: 128000,
            recommended: true,
          },
          'gpt-oss-120b-medium': {
            model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
            displayName: 'GPT-OSS 120B (Medium)',
            modelProvider: 'MODEL_PROVIDER_OPENAI',
            apiProvider: 'API_PROVIDER_OPENAI_VERTEX',
            maxTokens: 131072,
            maxOutputTokens: 32768,
            recommended: true,
            modelExperiments: {
              experiments: {
                CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                  stringValue: JSON.stringify({ max_token_limit: '80000' }),
                },
              },
            },
          },
        },
      },
    };

    const cat = parseAvailableModelsCatalog(availResponse);
    assert.equal(cat.families.geminiFlagship, '5 Xenon');
    assert.equal(cat.families.geminiFast, '5 Helium');
    assert.equal(cat.families.geminiTopEffort, 'XHigh');
    assert.equal(cat.families.claudeFlagship, 'Titan 6.0');
    assert.equal(cat.families.claudeFast, 'Sonnet 5.5');
    assert.equal(cat.families.claudeTopEffort, 'Max');

    const xenon = cat.byEnum.get('MODEL_PLACEHOLDER_M910');
    assert.equal(xenon.modelId, 'gemini-5-xenon-xhigh');
    assert.equal(xenon.thinkingEffort, 'XHigh');
    assert.equal(xenon.ceiling, 768000);
    assert.equal(xenon.maxTokens, 2097152);
    assert.equal(xenon.isFlagship, true);
    assert.ok(!JSON.stringify(cat.snapshot).includes('XXXXX'), 'strips huge modelExperiments prompt blobs');

    const helium = cat.byEnum.get('MODEL_PLACEHOLDER_M920');
    assert.equal(helium.isFlagship, false);

    const orch = cat.byEnum.get('MODEL_PLACEHOLDER_M930');
    assert.equal(orch.thinkingEffort, 'XHigh');
    assert.equal(orch.isFlagship, true);

    const gpt = cat.byEnum.get('MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
    assert.equal(gpt.thinkingEffort, 'Medium');
    assert.equal(gpt.ceiling, 80000);

    // Additive merge retains retired models when dropped from a subsequent server snapshot
    const nextAvail = {
      response: {
        ...availResponse.response,
        models: { 'gemini-5-xenon-high': availResponse.response.models['gemini-5-xenon-high'] },
      },
    };
    const mergedSnap = mergeModelCatalogSnapshots(cat.snapshot, parseAvailableModelsCatalog(nextAvail).snapshot);
    assert.equal(mergedSnap.modelsBySlug['gpt-oss-120b-medium'].retired, true);
    assert.equal(mergedSnap.modelsBySlug['gpt-oss-120b-medium'].ceiling, 80000);
    assert.equal(mergedSnap.enumsToSlug.MODEL_OPENAI_GPT_OSS_120B_MEDIUM, 'gpt-oss-120b-medium');
  });
});
