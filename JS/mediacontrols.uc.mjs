import { FileSystem } from "chrome://userchromejs/content/utils.sys.mjs";

class MediaControlManager {
    _mediaControllers = new Map();
    _mediaUpdateIntervals = new Map();

    mediaControlsContainer = null;
    mediaControlTemplate = null;
    supportedKeys = [
        'playpause',
        'previoustrack',
        'nexttrack',
        'seekforward',
        'seekbackward',
    ];

    _tabTimeout = null;
    _controllerSwitchTimeout = null;

    async init() {
        const panelFile = await FileSystem.readFile("mediacontrols/xhtml/panel.xhtml");
        const toolbarFile = await FileSystem.readFile("mediacontrols/xhtml/toolbar.xhtml");
        const toolbarItemFile = await FileSystem.readFile("mediacontrols/xhtml/toolbarItem.xhtml");
        const parsedToolbarItem = window.MozXULElement.parseXULToFragment(toolbarItemFile.content());

        if (!panelFile || !toolbarFile) {
            console.error("Failed to load media controls files.");
        }

        document.querySelector("#mainPopupSet")
            .appendChild(window.MozXULElement.parseXULToFragment(panelFile.content()));
        document.querySelector("#customizableui-special-spring2")
            .after(window.MozXULElement.parseXULToFragment(toolbarFile.content()));

        const panel = document.querySelector("#PanelUI-MediaControls");
        this.mediaControlsContainer = panel.querySelector("#media-controls-container");
        this.mediaControlTemplate = parsedToolbarItem.cloneNode(true);

        this.onPlaybackstateChange = this._onPlaybackstateChange.bind(this);
        this.onSupportedKeysChange = this._onSupportedKeysChange.bind(this);
        this.onMetadataChange = this._onMetadataChange.bind(this);
        this.onDeactivated = this._onDeactivated.bind(this);
        this.onPipModeChange = this._onPictureInPictureModeChange.bind(this);
        this.onPositionstateChange = this._onPositionstateChange.bind(this);

        this.#initEventListeners();

        const button = document.querySelector("toolbarbutton#media-controls");
        button.disabled = true;

        button.addEventListener("mousedown", (event) => {
            if (button.hasAttribute("disabled")) return;
            window.PanelUI.showSubView("PanelUI-MediaControls", button, event);
        });
    }

    #initEventListeners() {
        this.mediaControlsContainer.addEventListener('mousedown', (event) => {
            if (!event.target.closest('toolbarbutton')) {
                const controlId = event.target.closest('toolbaritem').getAttribute('browser-id');
                const controller = this._mediaControllers.get(parseInt(controlId))?.controller;
                if (controller) this.onMediaFocus(controller);
            }
        });

        this.mediaControlsContainer.addEventListener('command', (event) => {
            const controlId = event.target.closest('toolbaritem').getAttribute('browser-id');
            if (!controlId) return;

            const { controller, browser } = this._mediaControllers.get(parseInt(controlId));
            const button = event.target.closest('toolbarbutton');
            if (!button) return;

            switch (button.id) {
                case 'media-pip-button': this.onMediaPip(browser); break;
                case 'media-previoustrack-button': this.onMediaPlayPrev(controller); break;
                case 'media-nexttrack-button': this.onMediaPlayNext(controller); break;
                case 'media-playpause-button': this.onMediaToggle(controller); break;
                case 'media-focus-button': this.onMediaFocus(controller); break;
                case 'media-seekforward-button': this.onSeekForward(controller); break;
                case 'media-seekbackward-button': this.onSeekBackward(controller); break;
            }
        });

        window.addEventListener('TabClose', this.onTabDiscardedOrClosed.bind(this));
        window.addEventListener('DOMAudioPlaybackStarted', (event) => {
            this.activateMediaControls(event.target.browsingContext.mediaController, event.target);
        });
    }

    onTabDiscardedOrClosed(event) {
        const linkedBrowser = event.target.linkedBrowser;
        if (!linkedBrowser?.browsingContext.mediaController) return;
        this.deinitMediaController(linkedBrowser.browsingContext.mediaController, linkedBrowser);
    }

    deinitMediaController(mediaController, browser) {
        if (!mediaController || !browser) return;

        const browserId = browser.browserId;
        if (!this._mediaControllers.has(browserId)) return;

        mediaController.removeEventListener('positionstatechange', this.onPositionstateChange);
        mediaController.removeEventListener('supportedkeyschange', this.onSupportedKeysChange);
        mediaController.removeEventListener('metadatachange', this.onMetadataChange);
        mediaController.removeEventListener('deactivated', this.onDeactivated);

        const controlElement = this.mediaControlsContainer.querySelector(`toolbaritem[browser-id="${browserId}"]`);
        if (controlElement) controlElement.remove();

        if (this._mediaUpdateIntervals.has(browserId)) {
            clearInterval(this._mediaUpdateIntervals.get(browserId));
            this._mediaUpdateIntervals.delete(browserId);
        }

        this._mediaControllers.delete(browserId);

        if (this._mediaControllers.size === 0) {
            this.hideMediaControls();
        }
    }

    showMediaControls() {
        document.querySelector("toolbarbutton#media-controls").disabled = false;
    }

    hideMediaControls() {
        document.querySelector("toolbarbutton#media-controls").disabled = true;
    }

    activateMediaControls(mediaController, browser) {
        if (!mediaController.isActive) return;

        const browserId = browser.browserId;

        if (this._mediaControllers.has(browserId)) {
            this.setupMediaControlUI(browserId);
            return;
        }

        const controlElementTemp = this.mediaControlTemplate.cloneNode(true);
        this.mediaControlsContainer.appendChild(controlElementTemp);

        const controlElement = this.mediaControlsContainer.lastElementChild;
        controlElement.setAttribute('browser-id', browserId);

        const seekbar = controlElement.querySelector('#media-seekbar');
        seekbar.addEventListener('input', this.onMediaSeekDrag.bind(this));
        seekbar.addEventListener('change', this.onMediaSeekEnd.bind(this));

        this._mediaControllers.set(browserId, {
            controller: mediaController,
            browser,
            element: controlElement
        });

        this.setupMediaControlUI(browserId);

        mediaController.addEventListener('positionstatechange', this.onPositionstateChange);
        mediaController.addEventListener('playbackstatechange', this.onPlaybackstateChange);
        mediaController.addEventListener('supportedkeyschange', this.onSupportedKeysChange);
        mediaController.addEventListener('metadatachange', this.onMetadataChange);
        mediaController.addEventListener('deactivated', this.onDeactivated);

        this.showMediaControls();
    }

    setupMediaControlUI(browserId) {
        const { controller, browser, element } = this._mediaControllers.get(browserId);
        if (!controller || !browser || !element) return;

        this.showMediaControls();
        this.updatePipButton(browserId);

        element.classList.toggle('playing', controller.isPlaying);

        const iconURL = browser.mIconURL || `page-icon:${browser.currentURI.spec}`;
        const metadata = controller.getMetadata();
        const titleElement = element.querySelector('#media-title');
        const artistElement = element.querySelector('#media-artist');
        const faviconElement = element.querySelector('#media-favicon');
        const serviceElement = element.querySelector('#media-service');
        const coverArtElement = element.querySelector('#media-coverart');

        coverArtElement.style.backgroundImage = `url(${metadata.artwork.at(-1).src})`;
        faviconElement.style.backgroundImage = `url(${iconURL})`;
        serviceElement.textContent = browser.currentURI.host;
        titleElement.textContent = metadata.title;
        artistElement.textContent = metadata.artist;

        this.supportedKeys.forEach(key => {
            const button = element.querySelector(`#media-${key}-button`);
            button.disabled = !controller.supportedKeys.includes(key);
        });
    }

    _onPositionstateChange(event) {
        for (const info of this._mediaControllers.values()) {
            if (info.controller.id === event.target.id) {
                const duration = event.duration;
                let position = event.position;
                const seekbar = info.element.querySelector('#media-seekbar');
                seekbar.setAttribute('duration', duration);
                seekbar.value = position / duration * 100;

                if (this._mediaUpdateIntervals.has(info.browser.browserId)) {
                    clearInterval(this._mediaUpdateIntervals.get(info.browser.browserId));
                }

                const updateInterval = 1000;
                this._mediaUpdateIntervals.set(info.browser.browserId, setInterval(() => {
                    if (info.controller.isPlaying) {
                        position += updateInterval / 1000;
                        seekbar.value = position / duration * 100;
                    } else {
                        clearInterval(this._mediaUpdateIntervals.get(info.browser.browserId));
                        this._mediaUpdateIntervals.delete(info.browser.browserId);
                    }
                }, updateInterval));

                break;
            }
        }
    }

    _onDeactivated(event) {
        for (const info of this._mediaControllers.values()) {
            if (info.controller.id === event.target.id) {
                this.deinitMediaController(event.target, info.browser);

                break;
            }
        }
    }

    _onPlaybackstateChange(event) {
        for (const info of this._mediaControllers.values()) {
            if (info.controller.id === event.target.id) {
                info.element.classList.toggle('playing', info.controller.isPlaying);

                break;
            }
        }
    }

    _onSupportedKeysChange(event) {
        for (const info of this._mediaControllers.values()) {
            if (info.controller.id === event.target.id) {
                this.supportedKeys.forEach(key => {
                    const button = info.element.querySelector(`#media-${key}-button`);
                    button.disabled = !event.target.supportedKeys.includes(key);
                });
            }
        }
    }

    _onMetadataChange(event) {
        for (const info of this._mediaControllers.values()) {
            if (info.controller.id === event.target.id) {
                const metadata = event.target.getMetadata();
                const titleElement = info.element.querySelector('#media-title');
                const artistElement = info.element.querySelector('#media-artist');

                titleElement.textContent = metadata.title;
                artistElement.textContent = metadata.artist;

                break;
            }
        }
    }

    _onPictureInPictureModeChange(event) {
        for (const info of this._mediaControllers.values()) {
            if (info.controller.id === event.target.id) {
                info.element.toggleAttribute('pip', event.target.isBeingUsedInPIPModeOrFullscreen);

                break;
            }
        }
    }

    onMediaSeekDrag(event) {
        const controlId = event.target.closest('toolbaritem').getAttribute('browser-id');
        if (!controlId) return;
        this._mediaControllers.get(parseInt(controlId)).controller?.pause();
    }

    onMediaSeekEnd(event) {
        const controlId = event.target.closest('toolbaritem').getAttribute('browser-id');
        if (!controlId) return;

        const newPosition = (event.target.value / 100) * parseFloat(event.target.getAttribute('duration'));
        const { controller } = this._mediaControllers.get(parseInt(controlId));
        controller.seekTo(newPosition);
        controller.play();
    }

    onSeekForward(controller) {
        if (controller?.supportedKeys.includes('seekforward')) {
            controller.seekForward(10);
        }
    }

    onSeekBackward(controller) {
        if (controller?.supportedKeys.includes('seekbackward')) {
            controller.seekBackward(10);
        }
    }

    onMediaPlayPrev(controller) {
        if (controller?.supportedKeys.includes('previoustrack')) {
            controller.prevTrack();
        }
    }

    onMediaPlayNext(controller) {
        if (controller?.supportedKeys.includes('nexttrack')) {
            controller.nextTrack();
        }
    }

    onMediaFocus(controller) {
        controller?.focus();
    }

    onMediaToggle(controller) {
        if (controller.isPlaying) {
            controller.pause();
        } else {
            controller.play();
        }
    }

    onMediaPip(browser) {
        browser.browsingContext.currentWindowGlobal
            .getActor('PictureInPictureLauncher')
            .sendAsyncMessage('PictureInPicture:KeyToggle');
    }

    updatePipButton(browserId) {
        const info = this._mediaControllers.get(browserId);
        if (!info) return;
        const { totalPipCount } = PictureInPicture.getEligiblePipVideoCount(info.browser);
        info.element.toggleAttribute('can-pip', totalPipCount > 0);
    }
}

if (document.readyState === "complete") {
    new MediaControlManager().init()
} else {
    window.addEventListener("load", () => new MediaControlManager().init(), { once: true });
}