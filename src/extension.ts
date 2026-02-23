import * as vscode from 'vscode';
import { LogEditorProvider } from './logEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(LogEditorProvider.register(context));

    context.subscriptions.push(
        vscode.commands.registerCommand('logLens.openRaw', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (target) {
                vscode.commands.executeCommand('vscode.openWith', target, 'default');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('logLens.toggleViewer', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (target) {
                vscode.commands.executeCommand('vscode.openWith', target, 'logLens.logViewer');
            }
        })
    );
}

export function deactivate() {}
