import * as vscode from 'vscode';
import * as path from 'path'
import * as cp from 'child_process'

class CscopeItem implements vscode.QuickPickItem, vscode.CallHierarchyItem {
	private rest: string;
	private text: string;
	// for QuickPickItem
	label: string;
	// for CallHierarchyItem
	detail: string;
	kind: vscode.SymbolKind;
	name: string;
	range: vscode.Range;
	selectionRange: vscode.Range;
	uri: vscode.Uri;

	constructor(uri: vscode.Uri, func: string, range: vscode.Range, rest: string, text: string) {
		const offset = vscode.workspace.rootPath ? vscode.workspace.rootPath.length + 1 : 0;
		this.uri = uri;
		this.name = func;
		this.rest = rest;
		this.text = text;
		this.label = func + ' : ' + rest;
		this.detail = uri.fsPath.substring(offset) + ':' + range.start.line.toString() + ':' + range.start.character.toString();
		this.kind = vscode.SymbolKind.Function;
		this.range = range;
		this.selectionRange = range;
	}

	getUri(): vscode.Uri {
		return this.uri;
	}

	getFile(): string {
		return this.uri.fsPath;
	}

	getFunction(): string {
		return this.name;
	}

	getLineNumber(): number {
		return this.range.start.line;
	}

	getColumnNumber(): number {
		return this.range.start.character;
	}

	getLine(): string {
		return this.rest;
	}
}

class CscopeQuery {
	private type: string;
	private pattern: string;
	private results: CscopeItem[];

	constructor(type: string, pattern: string) {
		this.type = type;
		this.pattern = pattern;
		this.results = [];
	}

	getType(): string {
		return this.type;
	}

	getPattern(): string {
		return this.pattern;
	}

	getResult(): CscopeItem[] {
		return this.results;
	}

	async setResults(output: string): Promise<void> {
		const lines = output.split('\n');
		for (let line of lines) {
			if (line.length < 3) {
				continue;
			}
			// TODO: what if file name contains a space?
			const file_last = line.indexOf(' ');
			const func_last = line.indexOf(' ', file_last + 1);
			const line_last = line.indexOf(' ', func_last + 1);
			const file = line.slice(0, file_last);
			const func = line.slice(file_last + 1, func_last);
			const lnum = parseInt(line.slice(func_last + 1, line_last)) - 1;
			const rest = line.slice(line_last + 1);
			let text = '';
			let cnum = 0;
			let length = 0;
			const root = vscode.workspace.rootPath ? vscode.workspace.rootPath : '';
			const uri = vscode.Uri.file(path.posix.join(root, file));
			try {
				const f = await vscode.workspace.openTextDocument(uri);
				text = f.lineAt(lnum).text;
				if (this.type === 'callee') {
					cnum = text.search(func);
					length = func.length;
				} else {
					cnum = text.search(this.pattern);
					length = this.pattern.length;
				}
				if (cnum == -1) {
					// If search pattern is not found in that line, still display the result
					// Because the intended result could be shifted by a few lines due to the
					// database not being up to date.
					// TODO: should we search the whole file instead at this point?
					cnum = 0;
					length = 0;
				}
				const range = new vscode.Range(lnum, cnum, lnum, cnum + length);
				this.results.push(new CscopeItem(uri, func, range, rest, text));
			} catch (err) {
				const msg: string = 'Could not open "' + file + '".';
				vscode.window.showWarningMessage(msg);
			}
		}
	}
};

class CscopePosition {
	private file: string;
	private line: number;
	private column: number;

	constructor(file: string, line: number, column: number) {
		this.file = file;
		this.line = line;
		this.column = column;
	}

	getFile(): string {
		return this.file;
	}

	getLineNumber(): number {
		return this.line;
	}

	getColumnNumber(): number {
		return this.column;
	}
}

export class Cscope implements vscode.CallHierarchyProvider {
	private output: vscode.OutputChannel;
	private config: vscode.WorkspaceConfiguration;
	private queryResult: CscopeQuery;
	private history: CscopePosition[];
	private fswatcher: vscode.FileSystemWatcher | undefined;
	private preview: vscode.TextEditor | undefined;
	private option: Record<string, string> = {
		'symbol': ' -0 ',
		'definition': ' -1 ',
		'callee': ' -2 ',
		'caller': ' -3 ',
		'text': ' -4 ',
		'egrep': ' -5 ',
		'file': ' -6 ',
		'include': ' -7 ',
		'set': ' -8 '
	};

	constructor(context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel('Cscope');
		this.config = vscode.workspace.getConfiguration('cscopeCode');
		this.queryResult = new CscopeQuery('', '');
		this.history = [];
		this.preview = undefined;

		// Check Auto Build Configuration
		if (this.config.get('auto')) {
			const root = vscode.workspace.rootPath ? vscode.workspace.rootPath : '';
			const database = path.posix.join(root, this.config.get('database', ''));
			const db = vscode.Uri.file(database);

			try {
				vscode.workspace.fs.stat(db).then((stat) => {
					const msg: string = '"' + db + '"' + ' exists.';
					this.output.appendLine(msg);
				}, (stat) => {
					const msg: string = '"' + db + '"' + ' does not exist.';
					this.output.appendLine(msg);
					this.build();
				});
			} catch {
				const msg: string = 'Exception occured while checking "' + db + '".';
				this.output.appendLine(msg);
				vscode.window.showInformationMessage(msg);
				this.build();
			}
			this.buildAuto();
		}

		// Register Configuration Watcher
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			this.config = vscode.workspace.getConfiguration('cscopeCode');
			if (e.affectsConfiguration('auto') || e.affectsConfiguration('extensions')) {
				this.buildAuto();
			}
		}));

		// Register Commands
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.build', () => this.build()));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.symbol', () => this.query('symbol')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.definition', () => this.query('definition')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.callee', () => this.query('callee')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.caller', () => this.query('caller')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.text', () => this.query('text')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.egrep', () => this.query('egrep')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.file', () => this.query('file')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.include', () => this.query('include')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.set', () => this.query('set')));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.result', () => this.quickPick(this.queryResult)));
		context.subscriptions.push(vscode.commands.registerCommand('extension.cscope-code.pop', () => this.popPosition()));

		// Register CallHierarchyProvider
		context.subscriptions.push(vscode.languages.registerCallHierarchyProvider('c', this));
	}

	public dispose(): void {
		if (this.fswatcher != undefined) {
			this.fswatcher.dispose();
			this.fswatcher = undefined;
		}
	}

	private async execute(command: string): Promise<{stdout: string; stderr: string}> {
		return new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
			cp.exec(command, {cwd: vscode.workspace.rootPath}, (error, stdout, stderr) => {
				if (error) {
					reject({stdout, stderr});
				} else {
					resolve({stdout, stderr});
				}
			});
		});
	}

	private async build(): Promise<void> {
		const cmd: string = this.config.get('build') + ' -f ' + this.config.get('database');
		this.output.appendLine(cmd);
		const prog = vscode.window.setStatusBarMessage('Building "' + this.config.get('database') + '"...');
		await this.execute(cmd).then(({stdout, stderr}) => {
			const msg: string = '"' + this.config.get('database') + '" is updated.'
			this.output.appendLine(msg);
			vscode.window.setStatusBarMessage(msg, 5000);
		}, ({stdout, stderr}) => {
			const msg: string = 'Error occurred while updating "' + this.config.get('database') + '".'
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			this.output.appendLine(stderr);
		}).catch(({stdout, stderr}) => {
			const msg: string = 'Exception occurred while updating "' + this.config.get('database') + '".'
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			this.output.appendLine(stderr);
		});
		prog.dispose();
	}

	private buildAuto(): void {
		if (this.fswatcher != undefined) {
			this.fswatcher.dispose();
			this.fswatcher = undefined;
		}
		if (this.config.get('auto')) {
			const root = vscode.workspace.rootPath ? vscode.workspace.rootPath : '';
			const pattern: string = path.posix.join(root, '**/*.{' + this.config.get('extensions') + '}');
			this.output.appendLine('Register Auto Build Pattern: "' + pattern + '"');
			this.fswatcher = vscode.workspace.createFileSystemWatcher(pattern);
			this.fswatcher.onDidChange(() => this.build());
			this.fswatcher.onDidCreate(() => this.build());
			this.fswatcher.onDidDelete(() => this.build());
		}
	}

	private findWord(): string {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			const msg: string = 'Cannot find Active Text Editor.';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			return '';
		}
		const document = editor.document;
		const selection = editor.selection;
		if (!selection.isEmpty) {
			return document.getText(selection);
		}
		const range = document.getWordRangeAtPosition(selection.active);
		if (!range) {
			return '';
		}
		return document.getText(range);
	}

	private moveCursor(file: string, line: number, column: number, preview: boolean = false): void {
		vscode.workspace.openTextDocument(file).then((f: vscode.TextDocument) => {
			const range: vscode.Range = new vscode.Range(line, column, line, column);
			let option: vscode.TextDocumentShowOptions = {
				preserveFocus: false,
				preview: false,
				selection: range,
				viewColumn: vscode.ViewColumn.Active
			};
			if (preview) {
				option.preserveFocus = true;
				option.preview = true;
				option.viewColumn = vscode.ViewColumn.Beside;
			}
			vscode.window.showTextDocument(f, option).then((e: vscode.TextEditor) => {
				if (preview) {
					if (this.preview != undefined && this.preview != e) {
						this.preview.hide();
					}
					this.preview = e;
				}
			}), ((error: any) => {
				const msg: string = 'Cannot show "' + file + '".';
				this.output.appendLine(msg);
				vscode.window.showInformationMessage(msg);
				});
		}), ((error: any) => {
			const msg: string = 'Cannot open "' + file + '".';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
		});
	}

	private pushPosition(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			const msg: string = 'Cannot find Active Text Editor.';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			return;
		}
		const file = editor.document.uri.fsPath;
		const line = editor.selection.active.line;
		const column = editor.selection.active.character;
		this.history.push(new CscopePosition(file, line, column));
	}

	private popPosition(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			const msg: string = 'Cannot find Active Text Editor.';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			return;
		}
		const pos = this.history.pop();
		if (!pos) {
			const msg: string = 'End of History.';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			return;
		}
		this.moveCursor(pos.getFile(), pos.getLineNumber(), pos.getColumnNumber());
	}

	private quickPick(result: CscopeQuery): void {
		if (result.getPattern() == '') {
			return;
		}
		const quickPick = vscode.window.createQuickPick<CscopeItem>();
		quickPick.items = result.getResult();
		quickPick.onDidHide(() => {
			if (this.preview != undefined) {
				this.preview.hide();
				this.preview = undefined;
			}
			quickPick.dispose();
		});
		if (this.config.get('preview')) {
			quickPick.onDidChangeActive(() => {
				const item: CscopeItem = quickPick.activeItems[0];
				if (item) {
					this.moveCursor(item.getFile(), item.getLineNumber(), item.getColumnNumber(), true);
				}
			});
		}
		quickPick.onDidAccept(() => {
			const item: CscopeItem = quickPick.selectedItems[0];
			if (item) {
				this.pushPosition();
				this.moveCursor(item.getFile(), item.getLineNumber(), item.getColumnNumber());
			}
			quickPick.hide();
		});
		quickPick.show();
	}

	private async queryPattern(option: string, pattern: string): Promise<void> {
		const cmd: string = this.config.get('query') + ' -f ' + this.config.get('database') + this.option[option] + pattern;
		this.output.appendLine(cmd);
		const prog = vscode.window.setStatusBarMessage('Querying "' + pattern + '"...');
		let output = '';
		await this.execute(cmd).then(({stdout, stderr}) => {
			this.queryResult = new CscopeQuery(option, pattern);
			this.output.appendLine(stdout);
			output = stdout;
		}, ({stdout, stderr}) => {
			const msg: string = 'Error occurred while querying: "' + cmd + '".';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			this.output.appendLine(stderr);
		}).catch(({stdout, stderr}) => {
			const msg: string = 'Exception occurred while querying: "' + cmd + '".';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			this.output.appendLine(stderr);
		});
		await this.queryResult.setResults(output);
		prog.dispose();
	}

	private async query(option: string): Promise<void> {
		const word = await vscode.window.showInputBox({value: this.findWord()});
		if (!word) {
			const msg: string = 'Cannot get pattern from the input box.';
			this.output.appendLine(msg);
			vscode.window.showInformationMessage(msg);
			return;
		}
		await this.queryPattern(option, word);
		this.quickPick(this.queryResult);
	}

	prepareCallHierarchy(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CallHierarchyItem | undefined {
		const range = document.getWordRangeAtPosition(position);
		if (!range) {
			return undefined;
		}
		const word = document.getText(range);
		return new vscode.CallHierarchyItem(vscode.SymbolKind.Function, word, '', document.uri, range, range);
	}

	async provideCallHierarchyOutgoingCalls(item: vscode.CallHierarchyItem, token: vscode.CancellationToken): Promise<vscode.CallHierarchyOutgoingCall[] | undefined> {
		let document = await vscode.workspace.openTextDocument(item.uri);
		let outgoingCallItems: vscode.CallHierarchyOutgoingCall[] = [];
		await this.queryPattern('callee', item.name);
		for (let result of this.queryResult.getResult()) {
			const outgo = new vscode.CallHierarchyOutgoingCall(result, [result.range]);
			outgoingCallItems.push(outgo);
		}
		return outgoingCallItems;
	}

	async provideCallHierarchyIncomingCalls(item: vscode.CallHierarchyItem, token: vscode.CancellationToken): Promise<vscode.CallHierarchyIncomingCall[]> {
		let document = await vscode.workspace.openTextDocument(item.uri);
		let incomingCallItems: vscode.CallHierarchyIncomingCall[] = [];
		await this.queryPattern('caller', item.name);
		for (let result of this.queryResult.getResult()) {
			const income = new vscode.CallHierarchyIncomingCall(result, [result.range]);
			incomingCallItems.push(income);
		}
		return incomingCallItems;
	}
}

let cscope: Cscope | undefined;

export function activate(context: vscode.ExtensionContext): void {
	cscope = new Cscope(context);
	console.log('"cscope-code" is now active!');
}

export function deactivate(): void {
	if (cscope) {
		cscope.dispose();
		cscope = undefined;
	}
	console.log('"cscope-code" is now inactive!');
}
