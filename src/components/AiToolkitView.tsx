import React, { useMemo, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import {
  AI_PROMPT_PRESETS,
  BEND_GUIDE_MD,
  ERROR_RECOVERY_TABLE,
  buildAiKickoffPrompt,
} from '../kernel/starterKit';

export const AiToolkitView: React.FC = () => {
  const [appName, setAppName] = useState<string>(AI_PROMPT_PRESETS[0].appName);
  const [domain, setDomain] = useState<string>(AI_PROMPT_PRESETS[0].domain);
  const [invariants, setInvariants] = useState<string>(
    AI_PROMPT_PRESETS[0].invariants
  );
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);

  const promptText = useMemo(
    () => buildAiKickoffPrompt(appName, domain, invariants),
    [appName, domain, invariants]
  );

  const handleApplyPreset = (presetId: string) => {
    const found = AI_PROMPT_PRESETS.find((p) => p.id === presetId);
    if (!found) return;
    setAppName(found.appName);
    setDomain(found.domain);
    setInvariants(found.invariants);
  };

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(key);
      window.setTimeout(() => setCopiedTarget(null), 1600);
    } catch {
      // Clipboard may be restricted
    }
  };

  const handleDownloadGuide = () => {
    const blob = new Blob([BEND_GUIDE_MD], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'BEND_GUIDE.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* AI Kickoff Prompt Builder */}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                AI Kickoff Prompt Builder
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Teaches any model that has never seen Bend 2 how to architect a Rust + RustyBends project.
              </p>
            </div>
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-md">
              {AI_PROMPT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleApplyPreset(preset.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                    appName === preset.appName
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label
                htmlFor="kit-app-name"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Project Name
              </label>
              <input
                id="kit-app-name"
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>

            <div>
              <label
                htmlFor="kit-domain"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Application Description
              </label>
              <textarea
                id="kit-domain"
                rows={2}
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600 resize-y"
              />
            </div>

            <div>
              <label
                htmlFor="kit-invariants"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Laws to Prove (separate with semicolons or new lines)
              </label>
              <textarea
                id="kit-invariants"
                rows={3}
                value={invariants}
                onChange={(e) => setInvariants(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600 resize-y"
              />
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-slate-700">
              Generated Prompt (Paste into any AI Coding Agent)
            </span>
            <button
              type="button"
              onClick={() => handleCopy('prompt', promptText)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              {copiedTarget === 'prompt' ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied Prompt
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Prompt
                </>
              )}
            </button>
          </div>
          <pre className="p-4 bg-slate-950 text-slate-100 font-mono text-xs leading-6 whitespace-pre-wrap max-h-[340px] overflow-auto">
            {promptText}
          </pre>
        </div>
      </section>

      {/* Error-Code Recovery Table */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">
            Diagnostic Recovery Reference for AI Agents
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Exact before/after fixes for every RustyBends compile-time error so medium and frontier models self-correct without guessing.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-4 font-semibold">Code</th>
                <th className="py-2.5 px-4 font-semibold">Cause &amp; Rule</th>
                <th className="py-2.5 px-4 font-semibold">Failing Pattern</th>
                <th className="py-2.5 px-4 font-semibold">Corrected Pattern</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {ERROR_RECOVERY_TABLE.map((entry) => (
                <tr key={entry.code} className="align-top hover:bg-slate-50/60">
                  <td className="py-3 px-3 font-mono font-semibold text-red-700 whitespace-nowrap">
                    {entry.code}
                  </td>
                  <td className="py-3 px-3 text-slate-700 max-w-[260px]">
                    <div className="font-medium text-slate-900">{entry.cause}</div>
                    <div className="text-slate-500 mt-1">{entry.rule}</div>
                  </td>
                  <td className="py-3 px-3">
                    <pre className="font-mono text-[11px] leading-5 bg-slate-100 text-slate-800 p-2 rounded whitespace-pre-wrap break-words">
                      {entry.badExample}
                    </pre>
                  </td>
                  <td className="py-3 px-3">
                    <pre className="font-mono text-[11px] leading-5 bg-emerald-50 text-emerald-950 p-2 rounded whitespace-pre-wrap break-words">
                      {entry.fixedExample}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* BEND_GUIDE.md Preview */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              BEND_GUIDE.md (Drop-In Repo Playbook)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Commit this file at your repository root alongside AGENTS.md so every AI session understands Bend 2 quantities and laws automatically.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleCopy('guide', BEND_GUIDE_MD)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {copiedTarget === 'guide' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Markdown
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDownloadGuide}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download BEND_GUIDE.md
            </button>
          </div>
        </div>
        <pre className="p-4 bg-slate-950 text-slate-100 font-mono text-xs leading-6 whitespace-pre-wrap max-h-[380px] overflow-auto">
          {BEND_GUIDE_MD}
        </pre>
      </section>
    </div>
  );
};
