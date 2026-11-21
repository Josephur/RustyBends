import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, FileCode2, Terminal } from 'lucide-react';
import {
  KitFile,
  buildWorkspaceSetupScript,
  generateStarterKitFiles,
} from '../kernel/starterKit';

interface RustCrateKitViewProps {
  currentBendSource: string;
  generatedRustSource: string;
  lawLockFingerprint: string;
}

export const RustCrateKitView: React.FC<RustCrateKitViewProps> = ({
  currentBendSource,
  generatedRustSource,
  lawLockFingerprint,
}) => {
  const files = useMemo(
    () =>
      generateStarterKitFiles(
        currentBendSource,
        generatedRustSource,
        lawLockFingerprint
      ),
    [currentBendSource, generatedRustSource, lawLockFingerprint]
  );

  const setupScript = useMemo(() => buildWorkspaceSetupScript(files), [files]);

  const [selectedPath, setSelectedPath] = useState<string>(
    'rusty-bends-build/src/lib.rs'
  );
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const activeFile: KitFile =
    files.find((f) => f.path === selectedPath) ?? files[0];

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(key);
      window.setTimeout(() => setCopiedPath(null), 1600);
    } catch {
      // Clipboard may be restricted
    }
  };

  const triggerDownload = (filename: string, content: string, mime = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadFile = (file: KitFile) => {
    const filename = file.path.split('/').pop() ?? 'file.txt';
    triggerDownload(filename, file.content);
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">
            Local Rust Build-Crate Starter Kit (rusty-bends-build v1.0.0)
          </h2>
          <p className="text-xs text-slate-500 max-w-2xl">
            Zero-dependency Cargo <code className="text-slate-800">[build-dependencies]</code> crate:
            checks <code className="text-slate-800">bend.pin</code>, runs{' '}
            <code className="text-slate-800">bend --check-only</code> &amp;{' '}
            <code className="text-slate-800">--verdict</code>, enforces canonical AST{' '}
            <code className="text-slate-800">lock.rs</code> fingerprinting, erases{' '}
            <code className="text-slate-800">q=0</code> terms, and emits ADTs (<code className="text-slate-800">pub enum</code>),{' '}
            <code className="text-slate-800">match</code>, and verified functions into{' '}
            <code className="text-slate-800">OUT_DIR/verified.rs</code> — with 19{' '}
            <code className="text-slate-800">cargo test</code> unit tests.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handleCopy('__setup_sh__', setupScript)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {copiedPath === '__setup_sh__' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                Copied Script
              </>
            ) : (
              <>
                <Terminal className="w-3.5 h-3.5" />
                Copy Setup Script
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() =>
              triggerDownload(
                'setup-rusty-bends.sh',
                setupScript,
                'application/x-sh;charset=utf-8'
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            <Download className="w-3.5 h-3.5" />
            Download All (.sh)
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* File Tree */}
        <section className="lg:col-span-4 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-700">Workspace Files</span>
            <span className="text-slate-500 font-mono tabular-nums">{files.length} files</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {files.map((file) => {
              const isSelected = file.path === activeFile.path;
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => setSelectedPath(file.path)}
                    className={`w-full text-left px-4 py-3 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      isSelected
                        ? 'bg-slate-100 text-slate-900'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-mono text-xs font-medium">
                      <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{file.path}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                      {file.summary}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Active File Preview */}
        <section className="lg:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden min-w-0">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-xs font-semibold text-slate-900 truncate">
                {activeFile.path}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {activeFile.summary}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleCopy(activeFile.path, activeFile.content)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                {copiedPath === activeFile.path ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy File
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleDownloadFile(activeFile)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
            </div>
          </div>

          <pre className="bg-slate-950 text-slate-100 p-4 font-mono text-xs leading-6 overflow-x-auto max-h-[600px]">
            {activeFile.content}
          </pre>
        </section>
      </div>
    </div>
  );
};
