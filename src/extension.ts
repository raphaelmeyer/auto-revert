import * as vscode from 'vscode';
import * as git from './api/git'; // https://github.com/microsoft/vscode/blob/master/extensions/git/src/api/git.d.ts

class Configuration {
	public timeout: number = 120;
	public enabled: boolean = false;

	private listener: vscode.Disposable;
	private emitter = new vscode.EventEmitter<void>();

	public constructor() {
		this.getValues();
		this.listener = vscode.workspace.onDidChangeConfiguration(event => {
			this.getValues();
			this.emitter.fire();
		});
	}

	public dispose() {
		this.listener.dispose();
		this.emitter.dispose();
	}

	public get onDidChange() {
		return this.emitter.event;
	}

	private getValues() {
		let conf = vscode.workspace.getConfiguration('auto-revert');
		this.enabled = conf.get('enabled') || false;
		this.timeout = conf.get('timeout') || 120;
	}
}

class RepoWatcher {
	private readonly api: git.API;
	private readonly config: Configuration;
	private statusBar: vscode.StatusBarItem;

	private changeListeners: vscode.Disposable[] = [];
	private subcriptions: vscode.Disposable[] = [];

	private timer: NodeJS.Timeout | undefined = undefined;
	private remaining: number = 0;

	public constructor(api: git.API, config: Configuration, statusBar: vscode.StatusBarItem) {
		this.api = api;
		this.config = config;
		this.statusBar = statusBar;

		this.subcriptions.push(this.api.onDidOpenRepository(() => { this.refreshRepos(); }));
		this.subcriptions.push(this.api.onDidCloseRepository(() => { this.refreshRepos(); }));
		this.subcriptions.push(this.config.onDidChange(() => this.setup()));

		this.setup();
	}

	public dispose() {
		this.statusBar.hide();
		this.stopTimer();
		disposeAll(this.changeListeners);
		disposeAll(this.subcriptions);
	}

	private setup() {
		this.refreshRepos();
		if (this.config.enabled) {
			this.updateTimer();
			this.statusBar.show();
		} else {
			this.stopTimer();
			this.statusBar.hide();
		}
	}

	private refreshRepos() {
		disposeAll(this.changeListeners);
		if (this.config.enabled) {
			this.api.repositories.forEach(repo => {
				this.changeListeners.push(repo.state.onDidChange(() => {
					this.updateTimer();
				}));
			});
		}
	}

	private updateTimer() {
		if (this.isAnyRepoDirty()) {
			this.startTimer();
		} else {
			this.stopTimer();
		}
	}

	private isAnyRepoDirty() {
		return this.api.repositories.some(repo => {
			if (repo.state.workingTreeChanges.length > 0) { return true; }
			if (repo.state.indexChanges.length > 0) { return true; }
			return false;
		});
	}

	private startTimer() {
		if (!this.timer) {
			this.timer = setInterval(() => {
				this.remaining = this.remaining - 1;
				if (this.remaining <= 0) {
					this.stopTimer();
					this.resetHard();
					vscode.window.showInformationMessage("Time is up! Changes have been reverted.");
				} else {
					this.statusBar.text = "Auto Revert: " + this.remaining;
				}
			}, 1000);
			this.remaining = this.config.timeout;
		}
	}

	private stopTimer() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.statusBar.text = "Auto Revert: stopped";
	}

	private resetHard() {
		console.log('git reset --hard');
	}
}

export async function activate(context: vscode.ExtensionContext) {
	let api = await initializeGitApi();
	if (!api) {
		vscode.window.showErrorMessage("Extension vscode.git is missing.");
		return;
	}

	let config = new Configuration();
	context.subscriptions.push(config);

	let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	context.subscriptions.push(statusBar);

	let watcher = new RepoWatcher(api, config, statusBar);
	context.subscriptions.push(watcher);
}

export function deactivate() { }

async function initializeGitApi() {
	const extension = vscode.extensions.getExtension<git.GitExtension>("vscode.git");
	if (!extension) {
		return undefined;
	}

	if (!extension.isActive) {
		await extension.activate();
	}

	return extension.exports.getAPI(1);
}

function disposeAll(disposables: vscode.Disposable[]) {
	while (disposables.length > 0) {
		let item = disposables.pop();
		item?.dispose();
	}
}
