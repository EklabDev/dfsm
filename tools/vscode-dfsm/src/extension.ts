import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  analyzeDfsmDocument,
  detectDfsmDocument,
  findStateAtPosition,
  formatStatusBarText,
  type DfsmDiagnostic,
  type DfsmDocumentAnalysis,
  type SourceRange
} from './core';
import { DFSM_TEMPLATES } from './templates';
import {
  buildVisualizerGraph,
  buildVisualizerUpdatePayload,
  computeGraphLayout,
  renderVisualizerHtml
} from './visualizer';

const CONTEXT_KEY_IS_MACHINE = 'dfsm.isMachineDocument';

function toVsCodeRange(r: SourceRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(r.startLine0, r.startColumn0),
    new vscode.Position(r.endLine0, Math.max(r.endColumn0, r.startColumn0 + 1))
  );
}

function toVsCodeSeverity(severity: DfsmDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
  }
}

function toVsCodeDiagnostics(diagnostics: DfsmDiagnostic[]): vscode.Diagnostic[] {
  return diagnostics.map((d) => {
    const diag = new vscode.Diagnostic(
      toVsCodeRange(d.range),
      d.message,
      toVsCodeSeverity(d.severity)
    );
    diag.code = d.code;
    diag.source = 'dfsm';
    return diag;
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('dfsm');
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'dfsm.openVisualizer';
  statusBarItem.tooltip = 'Open DFSM Statechart Studio Visualizer';

  const analysisCache = new Map<string, DfsmDocumentAnalysis>();
  let visualizerPanel: vscode.WebviewPanel | undefined;
  let trackedDocumentUri: vscode.Uri | undefined;
  let suppressSelectionEcho = false;

  context.subscriptions.push(diagnosticCollection, statusBarItem);

  function evaluateDocument(doc: vscode.TextDocument): {
    isDfsm: boolean;
    analysis?: DfsmDocumentAnalysis;
  } {
    const detection = detectDfsmDocument({
      fileName: doc.fileName,
      content: doc.getText(),
      languageId: doc.languageId
    });

    if (!detection.isDfsm) {
      diagnosticCollection.delete(doc.uri);
      analysisCache.delete(doc.uri.toString());
      return { isDfsm: false };
    }

    const analysis = analyzeDfsmDocument(doc.getText());
    analysisCache.set(doc.uri.toString(), analysis);
    diagnosticCollection.set(doc.uri, toVsCodeDiagnostics(analysis.diagnostics));
    return { isDfsm: true, analysis };
  }

  function syncActiveEditorState(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      void vscode.commands.executeCommand('setContext', CONTEXT_KEY_IS_MACHINE, false);
      statusBarItem.hide();
      return;
    }

    const { isDfsm, analysis } = evaluateDocument(editor.document);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY_IS_MACHINE, isDfsm);

    if (isDfsm && analysis) {
      const machineId = analysis.machine?.id;
      const stateCount = analysis.machine?.explicitStateCount ?? 0;
      statusBarItem.text = formatStatusBarText(machineId, stateCount);
      const errorMode =
        analysis.machine?.errorStateMode === 'custom'
          ? 'custom states.error override'
          : 'implicit final error state';
      statusBarItem.tooltip = `DFSM v1.0 (${errorMode}) — Click to open Statechart Visualizer`;
      statusBarItem.show();

      if (visualizerPanel && trackedDocumentUri?.toString() !== editor.document.uri.toString()) {
        trackedDocumentUri = editor.document.uri;
        pushGraphToWebview(editor.document, analysis);
      }
    } else {
      statusBarItem.hide();
    }
  }

  function pushGraphToWebview(doc: vscode.TextDocument, analysis?: DfsmDocumentAnalysis): void {
    if (!visualizerPanel) return;
    const resolvedAnalysis = analysis ?? analyzeDfsmDocument(doc.getText());
    const graph = buildVisualizerGraph(resolvedAnalysis);
    const layout = computeGraphLayout(graph);
    const payload = buildVisualizerUpdatePayload(layout);
    visualizerPanel.title = `DFSM Studio: ${graph.machineId}`;
    void visualizerPanel.webview.postMessage({
      type: 'updateGraph',
      payload
    });
  }

  async function revealRangeInTrackedEditor(range: SourceRange): Promise<void> {
    if (!trackedDocumentUri) return;
    const doc = await vscode.workspace.openTextDocument(trackedDocumentUri);
    const existingEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === trackedDocumentUri?.toString()
    );

    suppressSelectionEcho = true;
    try {
      const editor =
        existingEditor ??
        (await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false
        }));

      const targetRange = toVsCodeRange(range);
      editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
      editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } finally {
      setTimeout(() => {
        suppressSelectionEcho = false;
      }, 120);
    }
  }

  function openVisualizerForDocument(doc: vscode.TextDocument): void {
    const analysis = analyzeDfsmDocument(doc.getText());
    analysisCache.set(doc.uri.toString(), analysis);
    diagnosticCollection.set(doc.uri, toVsCodeDiagnostics(analysis.diagnostics));
    trackedDocumentUri = doc.uri;

    const graph = buildVisualizerGraph(analysis);
    const layout = computeGraphLayout(graph);

    if (visualizerPanel) {
      visualizerPanel.reveal(vscode.ViewColumn.Beside, true);
      pushGraphToWebview(doc, analysis);
      return;
    }

    visualizerPanel = vscode.window.createWebviewPanel(
      'dfsm.statechartStudio',
      `DFSM Studio: ${graph.machineId}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const nonce = randomBytes(16).toString('hex');
    visualizerPanel.webview.html = renderVisualizerHtml(layout, { nonce });

    visualizerPanel.webview.onDidReceiveMessage(
      async (message: { type?: string; range?: SourceRange }) => {
        if (message?.type === 'revealRange' && message.range) {
          await revealRangeInTrackedEditor(message.range);
        }
      },
      undefined,
      context.subscriptions
    );

    visualizerPanel.onDidDispose(
      () => {
        visualizerPanel = undefined;
      },
      undefined,
      context.subscriptions
    );
  }

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('dfsm.openVisualizer', async (uriArg?: vscode.Uri) => {
      const targetDoc = uriArg
        ? await vscode.workspace.openTextDocument(uriArg)
        : vscode.window.activeTextEditor?.document;

      if (!targetDoc) {
        void vscode.window.showWarningMessage(
          'Open a DFSM YAML machine definition first to launch the Statechart Visualizer.'
        );
        return;
      }

      openVisualizerForDocument(targetDoc);
    }),

    vscode.commands.registerCommand('dfsm.validateMachine', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('No active editor to validate as a DFSM machine.');
        return;
      }

      const analysis = analyzeDfsmDocument(editor.document.getText());
      analysisCache.set(editor.document.uri.toString(), analysis);
      diagnosticCollection.set(editor.document.uri, toVsCodeDiagnostics(analysis.diagnostics));

      const idLabel = analysis.machine?.id ?? editor.document.fileName;
      if (analysis.errors.length === 0 && analysis.warnings.length === 0) {
        const count = analysis.machine?.explicitStateCount ?? 0;
        const errMode =
          analysis.machine?.errorStateMode === 'custom'
            ? 'custom states.error'
            : 'implicit final error';
        void vscode.window.showInformationMessage(
          `DFSM '${idLabel}' is valid (${count} states, ${errMode}).`
        );
      } else if (analysis.errors.length === 0) {
        void vscode.window
          .showWarningMessage(
            `DFSM '${idLabel}' passed schema checks with ${analysis.warnings.length} warning(s).`,
            'Show Problems'
          )
          .then((choice) => {
            if (choice === 'Show Problems') {
              void vscode.commands.executeCommand('workbench.actions.view.problems');
            }
          });
      } else {
        void vscode.window
          .showErrorMessage(
            `DFSM '${idLabel}' has ${analysis.errors.length} error(s) and ${analysis.warnings.length} warning(s).`,
            'Show Problems'
          )
          .then((choice) => {
            if (choice === 'Show Problems') {
              void vscode.commands.executeCommand('workbench.actions.view.problems');
            }
          });
      }
    }),

    vscode.commands.registerCommand('dfsm.newMachineFromTemplate', async () => {
      const picked = await vscode.window.showQuickPick(
        DFSM_TEMPLATES.map((tpl) => ({
          label: tpl.label,
          description: tpl.description,
          detail: tpl.detail,
          template: tpl
        })),
        {
          placeHolder: 'Select a DFSM v1.0 starter statechart template'
        }
      );

      if (!picked) return;

      const doc = await vscode.workspace.openTextDocument({
        language: 'yaml',
        content: picked.template.content
      });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    })
  );

  // Event Subscriptions for Automatic Detection, Live Validation & Two-Way Sync
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      syncActiveEditorState(editor);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      evaluateDocument(doc);
      if (vscode.window.activeTextEditor?.document.uri.toString() === doc.uri.toString()) {
        syncActiveEditorState(vscode.window.activeTextEditor);
      }
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      const { isDfsm, analysis } = evaluateDocument(event.document);
      const isActive =
        vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString();

      if (isActive) {
        void vscode.commands.executeCommand('setContext', CONTEXT_KEY_IS_MACHINE, isDfsm);
        if (isDfsm && analysis) {
          statusBarItem.text = formatStatusBarText(
            analysis.machine?.id,
            analysis.machine?.explicitStateCount ?? 0
          );
          statusBarItem.show();
        } else {
          statusBarItem.hide();
        }
      }

      if (
        visualizerPanel &&
        trackedDocumentUri?.toString() === event.document.uri.toString()
      ) {
        pushGraphToWebview(event.document, analysis);
      }
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnosticCollection.delete(doc.uri);
      analysisCache.delete(doc.uri.toString());
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (suppressSelectionEcho || !visualizerPanel) return;
      if (trackedDocumentUri?.toString() !== event.textEditor.document.uri.toString()) return;

      const cached =
        analysisCache.get(event.textEditor.document.uri.toString()) ??
        analyzeDfsmDocument(event.textEditor.document.getText());

      const cursor = event.selections[0]?.active;
      if (!cursor || !cached.machine) return;

      const hit = findStateAtPosition(cached.machine, cursor.line + 1, cursor.character + 1);
      if (hit.statePath) {
        void visualizerPanel.webview.postMessage({
          type: 'highlightState',
          stateId: hit.statePath,
          transitionId: hit.transitionId
        });
      }
    })
  );

  // Initial scan on activation
  for (const doc of vscode.workspace.textDocuments) {
    evaluateDocument(doc);
  }
  syncActiveEditorState(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // Subscriptions are disposed automatically via context.subscriptions
}
