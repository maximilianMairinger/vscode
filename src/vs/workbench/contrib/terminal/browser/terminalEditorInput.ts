/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dispose, toDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { IEditorInput } from 'vs/workbench/common/editor';
import { IThemeService, ThemeIcon } from 'vs/platform/theme/common/themeService';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { ITerminalInstance, ITerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { TerminalEditor } from 'vs/workbench/contrib/terminal/browser/terminalEditor';
import { getColorClass, getUriClasses } from 'vs/workbench/contrib/terminal/browser/terminalIcon';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { TerminalLocation, TerminalSettingId } from 'vs/platform/terminal/common/terminal';
import { IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { ILifecycleService } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { ConfirmOnKill } from 'vs/workbench/contrib/terminal/common/terminal';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { TerminalContextKeys } from 'vs/workbench/contrib/terminal/common/terminalContextKey';
import { Emitter } from 'vs/base/common/event';

export class TerminalEditorInput extends EditorInput {

	protected readonly _onDidRequestAttach = this._register(new Emitter<ITerminalInstance>());
	readonly onDidRequestAttach = this._onDidRequestAttach.event;

	static readonly ID = 'workbench.editors.terminal';

	private _isDetached = false;
	private _isShuttingDown = false;
	private _isReverted = false;
	private _copyInstance?: ITerminalInstance;
	private _terminalEditorFocusContextKey: IContextKey<boolean>;

	private _group: IEditorGroup | undefined;

	setGroup(group: IEditorGroup | undefined) {
		this._group = group;
	}

	get group(): IEditorGroup | undefined {
		return this._group;
	}

	override get typeId(): string {
		return TerminalEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return TerminalEditor.ID;
	}

	setTerminalInstance(instance: ITerminalInstance): void {
		if (this._terminalInstance) {
			throw new Error('cannot set instance that has already been set');
		}
		this._terminalInstance = instance;
		this._setupInstanceListeners();

		// Refresh dirty state when the confirm on kill setting is changed
		this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalSettingId.ConfirmOnKill)) {
				this._onDidChangeDirty.fire();
			}
		});
	}

	override copy(): IEditorInput {
		const instance = this._copyInstance || this._terminalInstanceService.createInstance({}, TerminalLocation.Editor);
		instance.focusWhenReady();
		this._copyInstance = undefined;
		return this._instantiationService.createInstance(TerminalEditorInput, instance.resource, instance);
	}

	/**
	 * Sets what instance to use for the next call to IEditorInput.copy, this is used to define what
	 * terminal instance is used when the editor's split command is run.
	 */
	setCopyInstance(instance: ITerminalInstance) {
		this._copyInstance = instance;
	}

	/**
	 * Returns the terminal instance for this input if it has not yet been detached from the input.
	 */
	get terminalInstance(): ITerminalInstance | undefined {
		return this._isDetached ? undefined : this._terminalInstance;
	}

	override isDirty(): boolean {
		if (this._isReverted) {
			return false;
		}
		const confirmOnKill = this._configurationService.getValue<ConfirmOnKill>(TerminalSettingId.ConfirmOnKill);
		if (confirmOnKill === 'editor' || confirmOnKill === 'always') {
			return this._terminalInstance?.hasChildProcesses || false;
		}
		return false;
	}

	override async revert(): Promise<void> {
		// On revert just treat the terminal as permanently non-dirty
		this._isReverted = true;
	}

	constructor(
		public readonly resource: URI,
		private _terminalInstance: ITerminalInstance | undefined,
		@IThemeService private readonly _themeService: IThemeService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IContextKeyService _contextKeyService: IContextKeyService
	) {
		super();

		this._terminalEditorFocusContextKey = TerminalContextKeys.editorFocus.bindTo(_contextKeyService);

		// Refresh dirty state when the confirm on kill setting is changed
		this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalSettingId.ConfirmOnKill)) {
				this._onDidChangeDirty.fire();
			}
		});
		if (_terminalInstance) {
			this._setupInstanceListeners();
		}
	}

	private _setupInstanceListeners(): void {
		const instance = this._terminalInstance;
		if (!instance) {
			return;
		}

		this._register(toDisposable(() => {
			if (!this._isDetached && !this._isShuttingDown) {
				instance.dispose();
			}
		}));

		const disposeListeners = [
			instance.onExit(() => this.dispose()),
			instance.onDisposed(() => this.dispose()),
			instance.onTitleChanged(() => this._onDidChangeLabel.fire()),
			instance.onIconChanged(() => this._onDidChangeLabel.fire()),
			instance.onDidFocus(() => this._terminalEditorFocusContextKey.set(true)),
			instance.onDidBlur(() => this._terminalEditorFocusContextKey.reset()),
			instance.onDidChangeHasChildProcesses(() => this._onDidChangeDirty.fire()),
			instance.statusList.onDidChangePrimaryStatus(() => this._onDidChangeLabel.fire())
		];

		// Don't dispose editor when instance is torn down on shutdown to avoid extra work and so
		// the editor/tabs don't disappear
		this._lifecycleService.onWillShutdown(() => {
			this._isShuttingDown = true;
			dispose(disposeListeners);
		});
	}

	override getName() {
		return this._terminalInstance?.title || this.resource.fragment;
	}

	override getLabelExtraClasses(): string[] {
		if (!this._terminalInstance) {
			return [];
		}
		const extraClasses: string[] = ['terminal-tab'];
		const colorClass = getColorClass(this._terminalInstance);
		if (colorClass) {
			extraClasses.push(colorClass);
		}
		const uriClasses = getUriClasses(this._terminalInstance, this._themeService.getColorTheme().type);
		if (uriClasses) {
			extraClasses.push(...uriClasses);
		}
		if (ThemeIcon.isThemeIcon(this._terminalInstance.icon)) {
			extraClasses.push(`codicon-${this._terminalInstance.icon.id}`);
		}
		return extraClasses;
	}

	/**
	 * Detach the instance from the input such that when the input is disposed it will not dispose
	 * of the terminal instance/process.
	 */
	detachInstance() {
		if (!this._isShuttingDown) {
			this._terminalInstance?.detachFromElement();
			this._isDetached = true;
		}
	}
}
