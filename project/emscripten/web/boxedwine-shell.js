        // Install mode (?install_mode=true) hides ALL chrome except the
        // canvas and a single "Press this when game installation is done"
        // button placed RIGHT UNDER the canvas (not floating). Clicking it
        // runs persistPcStorage() which snapshots the emulator filesystem
        // into IndexedDB + triggers a zip download so the installed game
        // survives the next reload.
        (function(){
            var search = (window.location.search || '').toLowerCase();
            var installMode = /[?&]install_mode=(true|1|yes)\b/.test(search);
            if (!installMode) return;
            window.__installMode = true;   // FPS overlay sampler reads this to stay hidden
            var apply = function(){
                var hide = function(el){ if (el) el.style.display = 'none'; };
                hide(document.getElementById('controlsPanel'));
                hide(document.getElementById('controlsToggleBtn'));
                hide(document.getElementById('fpsOverlay'));
                hide(document.getElementById('output'));
                // Uncheck Show FPS so the sampler doesn't bring it back.
                var showFPS = document.getElementById('showFPS');
                if (showFPS) showFPS.checked = false;
                // Uncheck the iPhone log toggle if present.
                var toggleLog = document.getElementById('toggleLog');
                if (toggleLog) { toggleLog.checked = false; }
                hide(document.getElementById('logToggleWrap'));

                var btn = document.getElementById('installDoneBtn');
                if (!btn) return;
                // Move the button into document flow right after the canvas
                // border so it renders directly under the canvas instead of
                // floating at the bottom of the viewport.
                var border = document.querySelector('.emscripten_border');
                if (border && border.parentNode) {
                    border.parentNode.insertBefore(btn, border.nextSibling);
                }
                // Replace fixed positioning with inline styles.
                btn.setAttribute('style', [
                    'display: block',
                    'margin: 16px auto',
                    'padding: 16px 32px',
                    'font-size: 18px',
                    'font-weight: 600',
                    'background: #2d7ef7',
                    'color: #fff',
                    'border: none',
                    'border-radius: 10px',
                    'box-shadow: 0 4px 14px rgba(0,0,0,0.4)',
                    'cursor: pointer',
                    'width: auto',
                    'max-width: 90vw'
                ].join(';'));
                btn.onclick = function(){
                    btn.disabled = true;
                    btn.textContent = 'Saving PC storage…';
                    try { persistPcStorage(); } catch(e) { console.error(e); }
                };
            };
            if (document.readyState !== 'loading') apply();
            else document.addEventListener('DOMContentLoaded', apply);
        })();

        // Honor ?dmt=true URL param to pre-check the "Disable Mouse Tracking"
        // box on load. Default (missing or false) leaves it unchecked so the
        // cursor follows the mouse like a normal Diablo install.
        (function(){
            var search = (window.location.search || '').toLowerCase();
            var dmt = /[?&]dmt=(true|1|yes)\b/.test(search);
            var apply = function(){
                var cb = document.getElementById('disableMouseTracking');
                if (!cb) { setTimeout(apply, 30); return; }
                cb.checked = dmt;
            };
            if (document.readyState !== 'loading') apply();
            else document.addEventListener('DOMContentLoaded', apply);
        })();

        // Click-only mouse tracking: normal mousemove events are dropped at
        // the DOM capture phase (so the game doesn't burn CPU chasing every
        // motion), but right before any click/mousedown/mouseup fires we
        // synthesize ONE mousemove at the click position so the guest
        // cursor jumps there. Net result: clicks land where the user meant,
        // FPS stays at ~20 because there's no per-motion cost.
        //
        // The "Disable Mouse Tracking (Enhance Perf)" hidden checkbox (set
        // via ?dmt=true URL param) reverts to full mouse tracking when
        // UNCHECKED. Default is checked-behavior (click-only) — see below.
        (function(){
            // Exposed globally so code OUTSIDE this closure (e.g. the
            // post-state-restore nudge) can also fire a mousemove that
            // bypasses the gate.
            window.__boxedwineSyntheticMouse = false;
            var gate = function(e){
                if (window.__boxedwineSyntheticMouse) return;  // let synthesized mousemove through
                e.stopImmediatePropagation();                  // drop every other mousemove
            };
            var prepareClick = function(e){
                // Before the click fires, fire a mousemove at the click
                // position so the guest cursor is at (clientX,clientY) when
                // the click event lands. Use the synthetic flag to bypass.
                var c = document.getElementById('canvas');
                if (!c) return;
                window.__boxedwineSyntheticMouse = true;
                try {
                    c.dispatchEvent(new MouseEvent('mousemove', {
                        clientX: e.clientX, clientY: e.clientY,
                        screenX: e.screenX, screenY: e.screenY,
                        button: 0, buttons: 0,
                        bubbles: true, cancelable: true, view: window
                    }));
                } finally {
                    window.__boxedwineSyntheticMouse = false;
                }
            };
            var installGate = function(){
                var c = document.getElementById('canvas');
                if (!c) { setTimeout(installGate, 50); return; }
                c.addEventListener('mousemove', gate, true);
                // Fire synthetic mousemove BEFORE the click-related events
                // reach emscripten. Capture phase + useCapture=true means
                // our listener runs first, does its sync dispatch, then the
                // event continues to SDL which will process move-then-click
                // in order.
                c.addEventListener('mousedown', prepareClick, true);
                c.addEventListener('mouseup', prepareClick, true);
                c.addEventListener('click', prepareClick, true);
                c.addEventListener('contextmenu', prepareClick, true);
            };
            if (document.readyState !== 'loading') installGate();
            else document.addEventListener('DOMContentLoaded', installGate);
        })();

        // Emscripten's SDL mouse-event handler occasionally calls
        // document.querySelector('') which throws "SyntaxError: The provided
        // selector is empty". The throw aborts the handler partway so the
        // mouse event data never reaches the game. Patch querySelector to
        // return null for empty/falsy selectors — one-line fix, zero
        // per-event overhead.
        (function(){
            var origQS = Document.prototype.querySelector;
            Document.prototype.querySelector = function(sel){
                if (!sel || sel === '') return null;
                return origQS.call(this, sel);
            };
            var origQSA = Document.prototype.querySelectorAll;
            Document.prototype.querySelectorAll = function(sel){
                if (!sel || sel === '') return [];
                return origQSA.call(this, sel);
            };
        })();

        // Make the canvas focusable and focus it automatically so mouse/key
        // events flow to the guest without the user first having to click
        // inside the game area. Runs on DOMContentLoaded since the element
        // may not exist yet when this script loads.
        function __wireCanvasFocus() {
            var c = document.getElementById('canvas');
            if (!c) return;
            if (c.tabIndex < 0 || c.tabIndex === undefined) c.tabIndex = 0;
            c.style.outline = 'none'; // avoid visible focus ring
            // Focus immediately and on any mouse enter / click, and keep it
            // focused by re-focusing on blur (otherwise the "Show console"
            // checkbox toggling focus steals it).
            try { c.focus({preventScroll:true}); } catch(e) { c.focus(); }
            c.addEventListener('mouseenter', function(){ c.focus({preventScroll:true}); });
            c.addEventListener('click', function(){ c.focus({preventScroll:true}); });
            // Also focus canvas if any other element steals focus
            window.addEventListener('click', function(e){
                var t = e.target;
                // Keep the form controls usable; only refocus if clicking outside them.
                if (t && t !== c && !(t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || t.tagName === 'A')) {
                    c.focus({preventScroll:true});
                }
            });
        }
        if (document.readyState !== 'loading') setTimeout(__wireCanvasFocus, 0);
        else document.addEventListener('DOMContentLoaded', __wireCanvasFocus);

        // Filter out D3DKMT stub spam from wine console so we can see other
        // log lines. wine's D3DKMTOpenAdapterFromHdc stub fires per-frame from
        // multiple render threads and floods the 500-line console buffer.
        window.__droppedD3DKMT = 0;
        window.__ringLog = [];
        (function(){
            var origLog = console.log;
            var origInfo = console.info;
            function filter(orig, args) {
                var msg = Array.prototype.slice.call(args).join(' ');
                if (msg.indexOf('D3DKMTOpenAdapterFromHdc') !== -1) {
                    window.__droppedD3DKMT++;
                    return;
                }
                window.__ringLog.push(msg);
                if (window.__ringLog.length > 8000) window.__ringLog.shift();
                orig.apply(console, args);
            }
            console.log = function(){ filter(origLog, arguments); };
            console.info = function(){ filter(origInfo, arguments); };
        })();

        // Capture runtime errors early so the "Exception thrown" banner
        // keeps the actual message visible. Guest-fault throws (`throw 1` /
        // `throw 2` from seg_access / seg_mapper) bubble to JS as a
        // WebAssembly.Exception of type "int"; those are INTENTIONAL control
        // flow inside the emulator — we suppress them so emscripten_set_main_loop
        // keeps firing on the next tick instead of crashing.
        window.__capturedErrors = [];
        window.__suppressedWasmExceptions = 0;
        window.addEventListener('error', e => {
            var isWasmInt = e.error && (e.error.message === 'int' || /Error:\s*int/.test(e.error.stack || ''));
            if (isWasmInt) {
                window.__suppressedWasmExceptions++;
                if ((window.__suppressedWasmExceptions % 200) === 1) {
                    console.warn('[shell] suppressed guest-fault WebAssembly.Exception (count=' + window.__suppressedWasmExceptions + ')');
                }
                e.preventDefault();
                e.stopImmediatePropagation && e.stopImmediatePropagation();
                return true;
            }
            // Suppress GLctx-undefined TypeErrors from _emscripten_gl* wrappers
            var isGLctxErr = e.error && e.error instanceof TypeError &&
                /GLctx|Cannot read properties of undefined/.test(String(e.error.message));
            if (isGLctxErr) {
                window.__suppressedGLctxErrors = (window.__suppressedGLctxErrors||0) + 1;
                if ((window.__suppressedGLctxErrors % 200) === 1) {
                    console.warn('[shell] suppressed GLctx-undefined TypeError (count=' + window.__suppressedGLctxErrors + ')');
                }
                e.preventDefault();
                e.stopImmediatePropagation && e.stopImmediatePropagation();
                return true;
            }
            window.__capturedErrors.push({ msg: e.message, src: (e.filename||'') + ':' + e.lineno + ':' + e.colno, stack: e.error && e.error.stack });
            console.error('[capturedError]', e.message, 'at', (e.filename||'') + ':' + e.lineno, e.error && e.error.stack);
        });
        window.addEventListener('unhandledrejection', e => {
            window.__capturedErrors.push({ rejection: String(e.reason) });
            console.error('[capturedRejection]', e.reason);
        });

        let ALLOW_PARAM_OVERRIDE_FROM_URL = true;
        let ROOT = "/root";
        let STORAGE_INDEXED_DB = "INDEXED_DB";
        let STORAGE_MEMORY = "MEMORY";

        let DEFAULT_AUTO_RUN = true;
        let DEFAULT_LOAD_DESKTOP = false;
        let DEFAULT_SOUND_ENABLED = true;
        let DEFAULT_APP_DIRECTORY = "/home/username/.wine/dosdevices/c:/files";
        let DEFAULT_BPP = 32;
        let DEFAULT_FRAME_SKIP = "0";
        let DEFAULT_ROOT_ZIP_FILE = "boxedwine.zip";
        //params
        let Config = {};
        Config.locateRootBaseUrl = ""; // ie "assets/"
        Config.locateAppBaseUrl = "";
        Config.locateOverlayBaseUrl = "";
        Config.urlParams = "";
        Config.storageMode = STORAGE_INDEXED_DB;
        Config.persist_d_drive = true;
        Config.showUploadDownload = false;
        Config.WorkingDir = "";
        Config.loadDesktop = false;
        Config.appSubfolder = "";
				
        var isRunning = false;
        var ExeFileTimer = null;

      	var statusElement = document.getElementById('status');
      	var progressElement = document.getElementById('progress');
      	var spinnerElement = document.getElementById('spinner');
        var dropzone = document.getElementById("dropzone");

        function hasUrlParams() {
            return window.location.search.length > 1;
        }

        function setConfiguration() {
            Config.appDirPrefix = DEFAULT_APP_DIRECTORY;
            Config.isAutoRunSet = getAutoRun();
            Config.loadDesktop = getLoadDesktop();
            Config.rootZipFile = getRootZipFile("root"); //MANUAL:"base.zip";
            Config.extraZipFiles = getZipFileList("overlay"); //MANUAL:"dlls.zip;fonts.zip";
            Config.appZipFile = getAppZipFile("app"); //MANUAL:"chomp.zip";
            Config.appPayload = getPayload("app-payload");
            Config.extraPayload = getPayload("overlay-payload");
            Config.Program = getExecutable(); //MANUAL:"CHOMP.EXE";
            Config.isSoundEnabled = getSound();
            Config.bpp = getBitsPerPixel();
			Config.cpu = getCPU();
			Config.envProp = getEnvProp();
			Config.emEnvProps = getEmscriptenEnvProps();
			Config.frameSkip = getFrameSkip();
			Config.resolution = getResolution();
			Config.ddrawOverridePath = getDDrawOverridePath();
			Config.payloadZipFile = "app.zip";
			Config.d_drive = "/d_drive";

            // Absolute program path (?p="/home/username/foo/bar.exe"): pre-bundled
            // inside boxedwine.zip. No -mount needed, but we should default the
            // working dir to the exe's parent so the guest can find sibling
            // data files (acsetup.cfg, .ags game data, audio.vox, etc.). And
            // strip the linux dir from the program so wine sees just the exe
            // name in the current dir — wine won't accept absolute linux paths
            // ("wine: cannot find L\"/home/...\"") but DOES find the exe in
            // cwd when given just the name.
            if (Config.Program.length > 0 && Config.Program.charAt(0) === '/' &&
                Config.WorkingDir.length === 0 && Config.appZipFile.length === 0 &&
                Config.appPayload.length === 0) {
                var lastSlash = Config.Program.lastIndexOf('/');
                if (lastSlash > 0) {
                    Config.WorkingDir = Config.Program.substring(0, lastSlash);
                    Config.Program = Config.Program.substring(lastSlash + 1);
                    console.log("Auto-split absolute program: cwd=" + Config.WorkingDir + " exe=" + Config.Program);
                }
            }

            // Allow URLs like ?app=ski32.exe to mean "run ski32.exe from ski32.zip".
            // The raw getAppZipFile turns that into "ski32.exe.zip", which no
            // zip has; split it back into program + matching zip instead.
            if (Config.appZipFile.toLowerCase().endsWith(".exe.zip")) {
                var exeName = Config.appZipFile.substring(0, Config.appZipFile.length - 4);
                var stem = exeName.substring(0, exeName.length - 4);
                Config.appZipFile = stem + ".zip";
                if (Config.Program.length === 0) {
                    Config.Program = exeName;
                }
                console.log("Interpreted app=" + exeName + " as zip=" + Config.appZipFile + " program=" + Config.Program);
            }

            // Dev default: auto-start Diablo Spawn when no app is picked from
            // the URL/payload. Bundled inside boxedwine.zip at the standard
            // wine prefix location, so no extra mount is needed. Also wire in
            // the cnc-ddraw replacement at C:\ddraw\ddraw.dll since wine's
            // own ddraw goes through wined3d → libGLX which isn't available
            // in this wasm build.
            if (Config.Program.length === 0 && Config.appZipFile.length === 0 && Config.appPayload.length === 0) {
                // ?sw=1 runs the pre-bundled diablosw.exe (DevilutionX / SDL
                // fork) instead of the original diablo_s.exe. Bypasses wine's
                // ddraw→wined3d→GL path entirely.
                if ((window.location.search||'').indexOf('sw=1') !== -1) {
                    Config.Program = "/home/username/diablosw.exe";
                    Config.WorkingDir = "/home/username";
                } else {
                    Config.Program = "/home/username/.wine/drive_c/Diablo/Spawn/diablo_s.exe";
                    Config.WorkingDir = "/home/username/.wine/drive_c/Diablo/Spawn";
                }
                // Opt into cnc-ddraw only with ?cnc=1 — it probes D3DKMT in
                // a tight loop in GDI mode which wastes cycles. Default path
                // now uses wine's builtin ddraw → wined3d → opengl32 → libGL.
                if (Config.ddrawOverridePath === null && (window.location.search||'').indexOf('cnc=1') !== -1) {
                    Config.ddrawOverridePath = Config.WorkingDir;
                }
                // Silence ALL wine debug output except errors. The D3DKMT fixme
                // spam alone fires per-frame from 3 threads and each message
                // is a printf → wasm stdout → JS console.log → DOM update,
                // which is a significant perf hit. `+err` keeps genuine
                // errors visible; everything else is off.
                if (Config.envProp.length === 0) {
                    Config.envProp = 'WINEDEBUG=-all,+err';
                }
                // Force wine ddraw into software mode (no wined3d/GL) with
                // ?nowined3d=1. This bypasses the D04F13C4 NULL-deref crash
                // seen when wined3d probes our stubbed libGL.
                var search = (window.location.search||'');
                if (search.indexOf('nowined3d=1') !== -1) {
                    Config.envProp += ';WINEDLLOVERRIDES=wined3d=disabled';
                }
                // Show ddraw trace channel with ?ddrawtrace=1.
                if (search.indexOf('ddrawtrace=1') !== -1) {
                    Config.envProp = Config.envProp.replace(/WINEDEBUG=-fixme/, 'WINEDEBUG=+ddraw,-fixme');
                }
                // Dump DLL load addresses with ?loaddll=1 so we can match a
                // crash IP to a specific module.
                if (search.indexOf('loaddll=1') !== -1) {
                    Config.envProp = Config.envProp.replace(/WINEDEBUG=-fixme/, 'WINEDEBUG=+loaddll,+module,-fixme');
                }
                console.log("Defaulting to Diablo: " + Config.Program +
                            "  (ddrawOverride=" + Config.ddrawOverridePath +
                            ", env=" + Config.envProp + ")");
            }
        }
        function allowParameterOverride() {
            if(Config.urlParams.length >0) {
                return true;
            }
            return ALLOW_PARAM_OVERRIDE_FROM_URL;
        }
        function getEmscriptenEnvProps() {
            var props = getParameter("em-env").trim();
            let allProps = [];
	        //allProps.push({key: 'LIBGL_NPOT', value: 2});
	        //allProps.push({key: 'LIBGL_DEFAULT_WRAP', value: 0});
	        //allProps.push({key: 'LIBGL_MIPMAP', value: 3});	        
            if(allowParameterOverride()){
                if(props.length > 6) {
                	if( (props.startsWith("%22") && props.endsWith("%22") )
                		|| (props.startsWith('%27') && props.endsWith('%27'))){
                    	props = props.substring(3, props.length - 3);
	                	props = props.split('%20').join(' ');
            			props.trim().split(";").forEach(function(item){
            				let kv = item.split(":");
            				if (kv.length == 2) {
    	    					let key = kv[0].trim();
    	        				let value = kv[1].trim();
    	        				let existingIndex = allProps.findIndex(v => v.key === key);
    	        				if (existingIndex > -1) {
    	        				    allProps.splice(existingIndex, 1);
								}
	            				allProps.push({key: key, value: value});
            				}
            			});
                	}else{
	                	console.log("EMSCRIPTEN ENV props parameter must be in quoted string");
                	}
                }
            }
            if(allProps.length > 0) {
                console.log("setting EMSCRIPTEN ENV props:");
            	allProps.forEach(function(prop){
            		console.log(prop.key + " = " + prop.value);
            	});
            }
            return allProps;
        }
        function getDDrawOverridePath() {
            var property = getParameter("ddrawOverride").trim();
            if(allowParameterOverride() && property.length > 0){
                if( (property.startsWith("%22") && property.endsWith("%22") )
                	|| (property.startsWith('%27') && property.endsWith('%27'))){
                    return property.substring(3, property.length - 3);
                }else{
	                console.log("ddrawOverride path must be in quoted string");
                }
            }
            return null;
        }
        function getEnvProp() {
            var property = getParameter("env").trim();
            if(allowParameterOverride()){
                if(property.length > 6) {
                	if( (property.startsWith("%22") && property.endsWith("%22") )
                		|| (property.startsWith('%27') && property.endsWith('%27'))){
                    	let kv = property.substring(3, property.length - 3).split(':');
                    	return '"' + kv[0].trim() + "=" + kv[1].trim() + '"';
                	}else{
	                	console.log("ENV property must be in quoted string");
                	}
                }
            }
            return '';
        }
        function getCPU() {
            var cpu = getParameter("cpu");
            if(!allowParameterOverride()){
                cpu = "";
            }else if(cpu == "p2") {
            }else if(cpu == "p3") {
            }else{
                cpu = "";
            }
            if(cpu.length > 0) {
            	console.log("setting CPU to: "+cpu);
            }
            return cpu;
        }
        function getResolution() {
            var resolution = getParameter("resolution");
            if(!allowParameterOverride()){
                resolution = null;
            }else{
            	if (resolution != null) {
            		if (resolution.indexOf('x') > -1) {
            			let resNumbers = resolution.split('x');
            			if (!(resNumbers.length == 2 && isNumber(resNumbers[0]) && isNumber(resNumbers[1]))) {
            				resolution = null;
            			}
            		} else {
            			resolution = null;
            		}
            	}
            }
            // Default to 640x480 (Diablo 1's native resolution) when no
            // explicit setting. The wine desktop otherwise defaults to
            // 800x600 which pushes 35% more pixels per frame; with 640x480
            // the blit bandwidth drops enough that we hit Diablo's native
            // 20 FPS on the CPU emulation budget.
            if (resolution == null) {
                resolution = "640x480";
                console.log("defaulting Resolution to: 640x480");
            } else {
            	console.log("setting Resolution to: "+resolution);
            }
            return resolution;
        }
        function isNumber(num) {
        	const result = Number(num);
        	return !isNaN(result) && result > 0 && result < 2000;
        }
        function getFrameSkip() {
            var frameskip =  getParameter("skipFrameFPS");
            if(!allowParameterOverride()){
                frameskip = DEFAULT_FRAME_SKIP;
            }else if(frameskip == ""){
                frameskip = DEFAULT_FRAME_SKIP;
            }else if(Number(frameskip) < 0 || Number(frameskip) > 50){
                frameskip = DEFAULT_FRAME_SKIP;
            }
            console.log("setting skipFrameFPS to: "+frameskip);
            return frameskip;
        }
        function getBitsPerPixel() {
            var bpp =  getParameter("bpp");
            if(!allowParameterOverride()){
                bpp = DEFAULT_BPP;
            }else if(bpp == "8") {
                bpp = 8;
            }else if(bpp == "16") {
                bpp = 16;
            }else if(bpp == "32"){
                bpp = 32;
            }else{
                bpp = DEFAULT_BPP;
            }
            console.log("setting BPP to: "+bpp);
            return bpp;
        }
        function getAutoRun() {
            var auto =  getParameter("auto");
            if(!allowParameterOverride()){
                auto = DEFAULT_AUTO_RUN;
            }else if(auto == "true") {
                auto = true;
            }else if(auto == "false"){
                auto = false;
            }else{
                auto = DEFAULT_AUTO_RUN;
            }
            console.log("setting auto run to: "+auto);
            return auto;
        }        
        function getLoadDesktop() {
            var loadDesktop =  getParameter("desktop");
            if(!allowParameterOverride()){
                loadDesktop = DEFAULT_LOAD_DESKTOP;
            }else if(loadDesktop == "true") {
                loadDesktop = true;
            }else if(loadDesktop == "false"){
                loadDesktop = false;
            }else{
                loadDesktop = DEFAULT_LOAD_DESKTOP;
            }
            console.log("setting load Desktop to: "+loadDesktop);
            return loadDesktop;
        }
        function getPayload(param) {
            var payload =  getParameter(param);
            if(!allowParameterOverride()){
                payload = "";
            }
            return payload;
        }
        function getSound() {
            var soundEnabled =  getParameter("sound");
            if(!allowParameterOverride()){
                soundEnabled = DEFAULT_SOUND_ENABLED;
            }else if(soundEnabled == "true") {
                soundEnabled = true;
            }else if(soundEnabled == "false"){
                soundEnabled = false;
            }else{
                soundEnabled = DEFAULT_SOUND_ENABLED;
            }
            console.log("setting sound to: "+soundEnabled);
            return soundEnabled;
        }
        function getExecutable() {
            var prog =  getParameter("p");
            if(!allowParameterOverride() || prog===""){
                console.log("not setting program to execute");
            }else{
                if(prog.startsWith("%22") && prog.endsWith("%22")){
                    prog = prog.substring(3, prog.length - 3);
                }else if(prog.startsWith('%27') && prog.endsWith('%27')){
                    prog = prog.substring(3, prog.length - 3);
                }
                // Properly URL-decode the path. Browsers accept %2F (slash),
                // %20 (space), %3A (colon), etc. in URL params; we used to
                // hand-roll only %20 → space which broke any path that had
                // %2F kept verbatim from the address bar (e.g. mobile browsers
                // that re-encode `/` as %2F when copy-pasting URLs).
                try {
                    prog = decodeURIComponent(prog);
                } catch (_) {
                    // malformed % sequence — fall back to legacy %20 handling
                    prog = prog.split('%20').join(' ');
                }
                console.log("setting program to execute to: "+prog);
            }
            return prog;
        }
        function getAppZipFile(param) {

            var filename =  getParameter(param);
            if(!allowParameterOverride() || filename===""){
                filename = "";
                console.log("not setting " + param + " zip file");
            }else{
                if(!filename.endsWith(".zip")){
                    filename = filename + ".zip";
                }
                console.log("setting " + param + " zip file to: "+filename);
            }
            return filename;
        }
        function getRootZipFile(param) {

            var filename =  getParameter(param);
            if(!allowParameterOverride() || filename===""){
                filename = DEFAULT_ROOT_ZIP_FILE;
            }else{
                if(!filename.endsWith(".zip")){
                    filename = filename + ".zip";
                }
            }
            console.log("setting " + param + " zip file to: "+filename);
            return filename;
        }
        function getZipFileList(param) {
            var zipFiles = [];
            var filenames =  getParameter(param);
            if(!allowParameterOverride() || filename===""){
                console.log("not setting " + param + " zip file(s)");
            }else{
                if(filenames.length > 0) {
                    var zipFilenames = filenames.split(';');
                    for(var i=0; i < zipFilenames.length;i++) {
                        var filename = zipFilenames[i];
                        if(!filename.endsWith(".zip")){
                            filename = filename + ".zip";
                        }
                        zipFiles.push(filename);
                    }
                }
            }
            if(zipFiles.length > 0) {
            	console.log("setting " + param + " zip file(s) to: "+zipFiles);
            }
            return zipFiles;
        }
        function getBase64Data(base64Data) {
            let bytes = atob(base64Data);
        	let contentLength = bytes.length;
    		var contents = new Uint8Array(contentLength);
			for (var i = 0; i < contentLength; i++) {
        		contents[i] = bytes.charCodeAt(i);
    		}
    		return contents;
        }
        function loadFile(pathPrefix, filename, callback) {
			fetch(pathPrefix + filename, { method: 'GET' }).then(function(response) {
      			if (response.status === 200) {
					response.arrayBuffer().then(function(buffer) {
						let arr = new Uint8Array(buffer);
						callback(arr);
    				});
      			} else {
      				console.log('Unable to load:' + filename + ' error:' + response.status);
      			}
			});
		}
        function buildAppFileSystem(callback) {
            if(Config.appPayload.length > 0){
            	let uint8Array = getBase64Data(Config.appPayload);
            	createFile("/", Config.payloadZipFile, uint8Array);
                callback();
            }else if(Config.appZipFile.length > 0){
            	loadFile(Config.locateAppBaseUrl, Config.appZipFile, (uint8Array) => {
            		if (Config.Program.length > 0) {            	
            			let zipEntries = getZipEntries(uint8Array);
            		    let folder = Config.appZipFile.toLowerCase().endsWith('.zip') ?
            		    	 Config.appZipFile.substring(0, Config.appZipFile.length - 4) : Config.appZipFile;
            			let executablePathAndFilename = folder + "/" + Config.Program;
            			let exeFileList = zipEntries.filter(e => !e.directory && e.filename === executablePathAndFilename);
            			if (exeFileList.length == 1) {
            				Config.appSubfolder = folder;
            			}
            		}
            		createFile("/", Config.appZipFile, uint8Array);
            		callback();
            	});
            }else{
                callback();
            }
        }
        function buildExtraFileSystems(callback) {
	        let extraFSs = [];
            // First, if the user has clicked "Persist PC Storage" before, pull
            // the saved overlay zip out of IndexedDB and stage it into the
            // emscripten FS so boxedwine picks it up via `-zip`.
            installPersistedOverlay(() => {
                if(Config.extraPayload.length > 0){
                    let uint8Array = getBase64Data(Config.extraPayload);
                    createFile("/", "overlay.zip", uint8Array);
                    callback();
                }else if(Config.extraZipFiles.length > 0){
                    for(let i = 0; i < Config.extraZipFiles.length; i++) {
                        loadFile(Config.locateOverlayBaseUrl, Config.extraZipFiles[i], (uint8Array) => {
                            createFile("/", Config.extraZipFiles[i], uint8Array);
                            extraFSs.push(Config.extraZipFiles[i]);
                            if(extraFSs.length == Config.extraZipFiles.length) {
                                callback();
                            }
                        });
                    }
                }else{
                    callback();
                }
            });
        }

        // Stage the persisted overlay zip into the emscripten FS and mark it
        // so getEmulatorParams() adds an extra `-zip` arg pointing at it.
        // We don't touch Config.extraZipFiles because that list drives a URL
        // fetch which would 404 for our locally-generated overlay.
        function installPersistedOverlay(callback) {
            try {
                if (window.location.search && window.location.search.indexOf('no-persist-load') !== -1) {
                    callback();
                    return;
                }
            } catch(_) {}
            getPersistedOverlayBytes().then(function(bytes) {
                if (!bytes) { callback(); return; }
                try {
                    createFile("/", PERSIST_OVERLAY_NAME, bytes);
                    Config.persistedOverlayInstalled = true;
                    console.log("Staged persisted overlay: " + PERSIST_OVERLAY_NAME +
                        " (" + (bytes.byteLength/1024).toFixed(1) + " KB)");
                } catch (e) {
                    console.warn("Failed to stage persisted overlay: " + e);
                }
                callback();
            }).catch(function(e){
                console.warn("getPersistedOverlayBytes failed: " + e);
                callback();
            });
        }
        function initBrowserFilesystem(callback) {
    		console.log("Use Storage mode: "+Config.storageMode);
			FS.mkdir(ROOT);
			FS.mkdir(Config.d_drive);
			if (Config.storageMode == STORAGE_INDEXED_DB) {
	  			FS.mount(IDBFS, {autoPersist: true}, ROOT);
	  			if (Config.persist_d_drive) {
	  				FS.mount(IDBFS, {autoPersist: true}, Config.d_drive);
	  			}
  				FS.syncfs(true, function (err) {
  					if (err) {
  						console.log('unable to sync folder: ' + ROOT);
  					} else {
  						callback();
  					}
				});
			} else {
				callback();
			}
		}
        function buildBrowserFileSystem() {
            if(Config.showUploadDownload){
                document.getElementById('uploadbtn').style.display = "";
                document.getElementById('downloadbtn').style.display = "";
            }
            spinnerElement.style.display = 'none';
            toggleConsole();
            if(Config.isAutoRunSet){
                start();
            }else{
                var startBtn = document.getElementById('startbtn');
                startBtn.disabled = false;
                startBtn.style.display = "";
                var soundToggle = document.getElementById('soundToggle');
                if(Config.isSoundEnabled){
                    soundToggle.checked = true;
                }
                document.getElementById('sound-checkbox').style.display = "";
            }
        }
        function closeGetFilesModal() { //called by boxedwine.html
		}
        function start() { //called by boxedwine.html
        	if(isRunning){
                return;
            }
            startEmulator();
        }
        function startEmulator() {
            isRunning = true;

            document.getElementById('startbtn').style.display = 'none';
            document.getElementById('sound-checkbox').style.display = 'none';
            document.getElementById('savestatebtn').style.display = '';
            document.getElementById('loadstatebtn').style.display = '';
            document.getElementById('persistpcbtn').style.display = '';
            hasPersistedStorage().then(function(has){
                if (has) document.getElementById('clearpersistbtn').style.display = '';
            });

            var params = getEmulatorParams();
            for(var i=0; i < params.length; i++) {
                Module['arguments'].push(params[i]);
            }

            document.getElementById('startbtn').textContent = "Running...";
            Module["removeRunDependency"]("setupBoxedWine");

            // If the user previously pressed "Persist PC Storage", load that
            // snapshot once wine has finished booting (we wait for the MIPS
            // counter to tick, indicating the scheduler is really running).
            autoLoadPersistedPcStorage();
        }
        var initialSetup = function(){
            console.log("running initial setup");
            setConfiguration();
            if (Config.emEnvProps.length > 0) {
            	Config.emEnvProps.forEach(function(prop){
            		ENV[prop.key] = prop.value;
            	});
            }
            Module["addRunDependency"]("setupBoxedWine");
            initBrowserFilesystem(() => {
            	spinnerElement.style.display = '';
            	spinnerElement.hidden = false;
            
	        	buildExtraFileSystems(() => {
    	        	buildAppFileSystem(() => {
    	            	loadFile(Config.locateRootBaseUrl, Config.rootZipFile, (rootZipfileBytes) => {
    	            	    createFile("/", Config.rootZipFile, rootZipfileBytes);
                        	buildBrowserFileSystem();
						});
                	});
	        	});
	        });
        }
        function getEntriesAsPromise(item, exeFiles, allFiles, firstCall) {
            return new Promise((resolve, reject) => {
                if(firstCall){
                    if(!Config.isAutoRunSet && !isRunning){
                        loadExeModal(exeFiles, allFiles);
                    }
                }
                if(item.isDirectory){
                    let reader = item.createReader();
                    let doBatch = () => {
                        reader.readEntries(entries => {
                            if (entries.length > 0) {
                                entries.forEach(function(entry){
                                    getEntriesAsPromise(entry, exeFiles, allFiles, false);
                                });
                                doBatch();
                            } else {
                                resolve();
                            }
                        }, reject);
                    };
                    doBatch();
                }else{
                    let fullPath = item.fullPath;
                    let uppercase = fullPath.toUpperCase();
                    allFiles.push(fullPath);
                    if(uppercase.endsWith(".EXE") || uppercase.endsWith(".BAT")){
                        exeFiles.push(fullPath);
                    }
                    item.file(function(item){uploadFile(item, fullPath, allFiles);}, e => console.log(e));
                }
            });
        }
        function loadExeModal(exeFiles, allFiles) {
            document.getElementById('modalLinkExe').click();
            var message = document.getElementById('message');
            message.innerHTML = "<p>Uploading files...</p>";
            ExeFileTimer = setInterval(function(){readyCheck(exeFiles, allFiles);}, 100);
        }
        function populateModalExe(exeFiles) {
            var root = document.getElementById('items');
            root.innerHTML = '';
            let listElement = document.createElement("lu");
            for(let i = 0; i < exeFiles.length; i++) {
                let fullPath = exeFiles[i];
                let element = document.createElement("li");
                element.addEventListener("click", function(event){execute(fullPath);}, false);
                element.innerHTML = fullPath;
                listElement.appendChild(element);
            }
            root.appendChild(listElement);
        }
        function execute(filename) {
            var root = document.getElementById('items');
            document.getElementById('openModalExeClick').click();

            var file = filename.substring(filename.lastIndexOf("/")+1, filename.length);
            var path = filename.substring(0, filename.lastIndexOf("/"));

            Config.WorkingDir = "/home/username/.wine/dosdevices/d:/" + path.substring(1);
            Config.Program = file;

            startEmulator();
        }
        function readyCheck(exeFiles, allFiles) {
            if(allFiles.length==0){
                clearInterval(ExeFileTimer);
                var message = document.getElementById('message');
                if (exeFiles.length == 0) {
	                message.innerHTML = 'No executable files found';                
                } else {
	                message.innerHTML = '';
                }
                populateModalExe(exeFiles);
            }
        }
        dropzone.addEventListener("dragover", function(event){
            event.preventDefault();
        }, false);
        dropzone.addEventListener("drop", function(event){
            event.preventDefault();
            let items = event.dataTransfer.items;
            let exeFiles = [];
            let allFiles = [];
            for(let i =0; i < items.length; i++){
                getEntriesAsPromise(items[i].webkitGetAsEntry(), exeFiles, allFiles, true);
            }
        }, false);
        function getEmulatorParams() {        
            let params = ["-root", ROOT];
            params.push("-zip");
    		params.push(Config.rootZipFile);
    		
            if(Config.extraZipFiles.length > 0){
                for(let i = 0; i < Config.extraZipFiles.length; i++) {
		            params.push("-zip");
    				params.push(Config.extraZipFiles[i]);
                }
            }    		
            if(Config.extraPayload.length > 0){
		        params.push("-zip");
    			params.push("overlay.zip");
            }
            // User-persisted overlay zip (from "Persist PC Storage"). Placed
            // last so its entries win over stock boxedwine.zip on path clash.
            if(Config.persistedOverlayInstalled){
                params.push("-zip");
                params.push(PERSIST_OVERLAY_NAME);
            }
            
            if (Config.appZipFile.length > 0) { // -mount $appZipFile "/home/username/files/"
    			params.push("-mount");
    			params.push(Config.appZipFile);
    			params.push(Config.appDirPrefix);          
			} else if (Config.appPayload.length > 0){ // -mount "app.zip" "/home/username/files/" 			
    			params.push("-mount");
    			params.push(Config.payloadZipFile);
    			params.push(Config.appDirPrefix);          			
            }
                        
            params.push("-mount_drive"); // -mount_drive "/d_drive" d
            params.push(Config.d_drive);
            params.push("d");
            
            if (Config.resolution != null) {
            	params.push("-resolution");
            	params.push(Config.resolution);
            }
            if (Config.ddrawOverridePath != null) {
            	params.push("-ddrawOverride");
            	params.push(Config.ddrawOverridePath);
            }
            if (Config.frameSkip != "0") {
            	params.push("-skipFrameFPS");
            	params.push(Config.frameSkip);
			}

            // Cache MPQ / large file reads in memory. Diablo re-reads its
            // spawn.mpq archive constantly; caching is a significant speedup
            // for emulator throughput. Enabled by default; opt out with
            // ?nocacheReads=1 if it causes issues.
            if (((window.location.search||'').indexOf('nocacheReads=1')) === -1) {
                params.push("-cacheReads");
            }
            
            if(!Config.isSoundEnabled){
                params.push("-nosound");
            }
            if(Config.bpp != DEFAULT_BPP){
                params.push("-bpp");
                params.push("" + Config.bpp);
            }
            if(Config.cpu.length > 0){
                params.push("-" + Config.cpu);
            }
            if(Config.envProp.length > 0){
                // Config.envProp may contain multiple semicolon-separated env
                // vars; emit one -env flag per var so the guest launcher sees
                // them independently.
                Config.envProp.split(';').map(s => s.trim()).filter(s => s.length>0).forEach(function(ev){
                    params.push("-env");
                    params.push(ev);
                });
            }
            // When the user disables sound on the boxedwine side, also point
            // any bundled SDL2 game (AGS, Unity, ...) at the dummy audio
            // driver so SDL_OpenAudioDevice doesn't block waiting for a real
            // device that won't appear. Match the bare KEY=VALUE format that
            // boxedwine's -env parser expects (no surrounding quotes — those
            // would become part of the env var name and value).
            if (!Config.isSoundEnabled) {
                params.push("-env");
                params.push('SDL_AUDIODRIVER=dummy');
            }
            // Disable msctf.dll. The Wine prefix only ships a 3.5KB stub of
            // it; SDL2's IME init calls CoCreateInstance(CLSID_TF_ThreadMgr)
            // which loops forever in apartment_add_dll trying to load the
            // stub, repeatedly logging the {529a9e6b-…} class-object failure.
            // SDL2 has a fallback path when msctf is unavailable, which is
            // strictly cheaper than the error loop. WINEDLLOVERRIDES syntax:
            // `name=` (empty value) means "do not load this DLL".
            params.push("-env");
            params.push('WINEDLLOVERRIDES=msctf=');
            // Force SDL2 to use the software renderer. Without this hint SDL2
            // tries d3d9 / d3d11 first; both fail in our wasm wine (no real
            // GPU drivers in the prefix) and the fallback path can leave
            // SDL2's RenderTarget in a bad state — the AGS Lighthouse main
            // menu renders as 5 thin Win32-themed bars instead of the actual
            // BEGIN/EXIT GUI when this hint is missing.
            params.push("-env");
            params.push('SDL_RENDER_DRIVER=software');
            // Don't let SDL2 grab the keyboard / disable WM hooks; some of
            // those probes block on X events that boxedwine never delivers.
            params.push("-env");
            params.push('SDL_VIDEO_X11_NET_WM_BYPASS_COMPOSITOR=0');

			if (!Config.loadDesktop) {
            	if(Config.WorkingDir.length > 0){
                	params.push("-w");
                	params.push(Config.WorkingDir);
            	}else if(Config.appPayload.length > 0 && Config.Program.length > 0 && Config.Program.substring(0 ,1) != "/"){
                	params.push("-w");
                	params.push(Config.appDirPrefix);
            	}else if(Config.appZipFile.length > 0 && Config.Program.length > 0 && Config.Program.substring(0 ,1) != "/"){
                	params.push("-w");
                	if (Config.appSubfolder.length > 0) {
                		params.push(Config.appDirPrefix + "/" + Config.appSubfolder);                
                	} else {
                		params.push(Config.appDirPrefix);
                	}
            	}
            }
        	params.push("/bin/wine");
            if(Config.Program.length > 0 && !Config.loadDesktop){
                if (Config.Program.endsWith('.bat')) {
                    params.push("cmd");
                    params.push("/c");
                }
                params.push(Config.Program);
            }else{
	            params.push("explorer");
    	        params.push("/desktop=shell");
            }
            console.log("Emulator params:" + params);
            return params;
        }
      var Module = {
        preRun: [initialSetup],
        arguments: [],
        postRun: [],
        print: (function() {
          var element = document.getElementById('output');
          if (element) element.value = ''; // clear browser cache
          return function(text) {
            text = Array.prototype.slice.call(arguments).join(' ');
            // These replacements are necessary if you render to raw HTML
            //text = text.replace(/&/g, "&amp;");
            //text = text.replace(/</g, "&lt;");
            //text = text.replace(/>/g, "&gt;");
            //text = text.replace('\n', '<br>', 'g');
            console.log(text);
            if (element) {
              element.value += text + "\n";
              element.scrollTop = element.scrollHeight; // focus on bottom
            }
          };
        })(),
        printErr: function(text) {
          text = Array.prototype.slice.call(arguments).join(' ');
          if (0) { // XXX disabled for safety typeof dump == 'function') {
            dump(text + '\n'); // fast, straight to the real console
          } else {
			console.error(text);
          }
        },
        canvas: (function() {
          var canvas = document.getElementById('canvas');

          // As a default initial behavior, pop up an alert when webgl context is lost. To make your
          // application robust, you may want to override this behavior before shipping!
          // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
          canvas.addEventListener("webglcontextlost", function(e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);
          canvas.width  = 800;
          canvas.height = 600;
          // SDL's GL window creation in emscripten sometimes shrinks the
          // canvas to a degenerate 1x1 while probing. Veto that.
          setInterval(function(){
              if (canvas.width < 320 || canvas.height < 200) {
                  console.warn('[shell] canvas size', canvas.width+'x'+canvas.height, '— restoring 800x600');
                  canvas.width = 800; canvas.height = 600;
              }
          }, 500);
          return canvas;
        })(),
        setStatus: function(text) {
          if (!Module.setStatus.last) Module.setStatus.last = { time: Date.now(), text: '' };
          if (text === Module.setStatus.text) return;
          var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
          var now = Date.now();
          if (m && now - Date.now() < 30) return; // if this is a progress update, skip it if too soon
          if (m) {
            text = m[1];
            progressElement.value = parseInt(m[2])*100;
            progressElement.max = parseInt(m[4])*100;
            progressElement.hidden = false;
            spinnerElement.hidden = false;
          } else {
            progressElement.value = null;
            progressElement.max = null;
            progressElement.hidden = true;
            if (!text) spinnerElement.hidden = true;
          }
          statusElement.innerHTML = text;
        },
        totalDependencies: 0,
        monitorRunDependencies: function(left) {
          this.totalDependencies = Math.max(this.totalDependencies, left);
          Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : '');
        }
      };
      Module.setStatus('Downloading...');
      window.onerror = function() {
        Module.setStatus('Exception thrown, see JavaScript console');
        spinnerElement.style.display = 'none';
        Module.setStatus = function(text) {
          if (text) Module.printErr('[post-exception status] ' + text);
        };
      };
        function startWithFiles(files) {
            for (let i = 0; i < files.length; i++) {
                uploadFile(files[i]);
            }
        }
        function uploadFile(file, fullPath, allFiles) {
            let filename = null;
            if(fullPath){
                filename = fullPath.startsWith("/") ? fullPath.substring(1) : fullPath;
            }else{
                filename = file.webkitRelativePath.length == 0 ? file.name : file.webkitRelativePath;
            }
            var filereader = new FileReader();
            filereader.file_name = file.name;
            filereader.onload = function(){readFile(this.result, filename, allFiles)};
            filereader.readAsArrayBuffer(file);
        }
        function readFile(data, name, allFiles) {
        	let filename = name.substring(name.lastIndexOf("/")+1,name.length);
            if(name.toLowerCase().endsWith('zip')){
				createFile(Config.d_drive, filename, new Uint8Array(data));
            }else{
                var done = false;
                var startIndex = 0;
                var base = Config.d_drive + "/";
                while(!done){
                    var dirIndex = name.indexOf("/", startIndex);
                    if(dirIndex == -1){
                        done =true;
                    }else{
                        var dirName = name.substring(startIndex, dirIndex);
                        if(dirName.length > 0) {
                            createFolder(base, dirName);
                            base = base + dirName + "/";
                        }
                        startIndex = dirIndex + 1;
                    }
                }
                createFile(base.substring(0,base.length-1), filename, new Uint8Array(data));
            }
            if(allFiles){
                allFiles.pop();
            }
        }
function createFolder(parent, dir) {
    try {
        FS.createPath(parent, dir, true, true);
    	console.log("Directory created :" + parent +  dir);
    } catch(ef) {
    	console.log("Unable to create folder:" + parent + dir + " error:" + ef);
    }
}
function createFile(dir, name, buf) {
    try {
        FS.createDataFile(dir, name, buf, true, true);
        console.log("File created:" + dir + "/" + name);
    } catch(e) {
        console.log("Unable to create file:" + dir + "/" + name + "  error:" + e);
    }
}
// State streaming bridge. The C++ side walks pages directly and hands us
// chunks; we accumulate them on the JS heap (separate from the 512MB wasm
// heap) and only turn them into a Blob at the end.
window.__boxedwineSaveChunks = null;
window.__boxedwineSaveTotal = 0;
window.__boxedwineSaveBegin = function() {
    window.__boxedwineSaveChunks = [];
    window.__boxedwineSaveTotal = 0;
};
window.__boxedwineSaveChunk = function(ptr, len) {
    // Copy out of HEAPU8 — slice() produces a detached Uint8Array on the JS heap.
    var src = HEAPU8.subarray(ptr, ptr + len);
    window.__boxedwineSaveChunks.push(new Uint8Array(src));
    window.__boxedwineSaveTotal += len;
};
window.__boxedwineSaveEnd = function() {
    return true;
};

// saveStateToDisk: like saveState() but instead of triggering a download,
// POST the serialized bytes to /save so the server overwrites
// diablo_save.boxedstate in-place. Used by the auto-save helper so future
// autoloads pick up the newest gameplay snapshot.
function saveStateToDisk() {
    if (!isRunning) { console.warn('[saveStateToDisk] not running'); return; }
    Module._requestSaveState();
    var poll = function() {
        if (!Module._isStateReady()) { setTimeout(poll, 50); return; }
        if (!Module._isStateSuccess()) {
            console.warn('[saveStateToDisk] state save failed');
            return;
        }
        var chunks = window.__boxedwineSaveChunks || [];
        var total = window.__boxedwineSaveTotal || 0;
        window.__boxedwineSaveChunks = null;
        var blob = new Blob(chunks, {type: 'application/octet-stream'});
        fetch('/save', { method: 'POST', body: blob, headers: {'Content-Type': 'application/octet-stream'} })
            .then(function(r){
                if (r.ok) console.log('[saveStateToDisk] saved '+total+' bytes to diablo_save.boxedstate');
                else console.warn('[saveStateToDisk] server returned '+r.status);
            })
            .catch(function(e){ console.warn('[saveStateToDisk] post failed:', e); });
    };
    setTimeout(poll, 100);
}
window.saveStateToDisk = saveStateToDisk;

function saveState() {
    if (!isRunning) {
        alert("Emulator is not running.");
        return;
    }

    try {
        Module._requestSaveState();

        var pollSave = function() {
            if (!Module._isStateReady()) {
                setTimeout(pollSave, 50);
                return;
            }

            if (!Module._isStateSuccess()) {
                window.__boxedwineSaveChunks = null;
                alert("Failed to save state. Check console for details.");
                return;
            }

            try {
                var chunks = window.__boxedwineSaveChunks || [];
                var total = window.__boxedwineSaveTotal || 0;
                window.__boxedwineSaveChunks = null;

                var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                var programName = Config.Program ? Config.Program.replace(/[^a-zA-Z0-9._-]/g, '_') : 'state';
                var filename = "boxedwine-" + programName + "-" + timestamp + ".boxedstate";

                var blob = new Blob(chunks, {type: "application/octet-stream"});
                var link = document.createElement('a');
                link.download = filename;
                link.href = window.URL.createObjectURL(blob);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(link.href);

                console.log("State saved: " + filename + " (" + total + " bytes)");
            } catch(e) {
                console.error("Error building saved state: " + e);
                alert("Error building saved state: " + e.message);
            }
        };
        setTimeout(pollSave, 100);
    } catch(e) {
        console.error("Error saving state: " + e);
        alert("Error saving state: " + e.message);
    }
}

function collectFileEntries(dir, entries) {
}

// Load-side bridge: keep the uploaded file on the JS heap and feed the C++
// parser chunks on demand through HEAPU8. Avoids staging the entire
// state into wasm memory.
window.__boxedwineLoadData = null;
window.__boxedwineLoadOffset = 0;
window.__boxedwineLoadRead = function(ptr, len) {
    var data = window.__boxedwineLoadData;
    if (!data) return 0;
    var avail = data.length - window.__boxedwineLoadOffset;
    var n = len < avail ? len : avail;
    if (n <= 0) return 0;
    HEAPU8.set(
        data.subarray(window.__boxedwineLoadOffset, window.__boxedwineLoadOffset + n),
        ptr
    );
    window.__boxedwineLoadOffset += n;
    return n;
};

function loadState(file) {
    if (!file) return;
    document.getElementById('loadstatefile').value = '';

    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            window.__boxedwineLoadData = new Uint8Array(e.target.result);
            window.__boxedwineLoadOffset = 0;

            Module._requestLoadState();

            var pollLoad = function() {
                if (!Module._isStateReady()) {
                    setTimeout(pollLoad, 50);
                    return;
                }
                window.__boxedwineLoadData = null;
                window.__boxedwineLoadOffset = 0;
                if (Module._isStateSuccess()) {
                    console.log("State loaded and resumed");
                } else {
                    alert("Failed to load state. Check console for details.");
                }
            };
            setTimeout(pollLoad, 100);
        } catch(e) {
            console.error("Error loading state: " + e);
            alert("Error loading state: " + e.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

// After a state restore, Diablo's render threads often stay parked on X11
// socket waits (they were idle when the state was captured). The game CPU
// keeps running but no new frames reach the canvas. Firing a cluster of
// input events wakes the blocked threads via wine's normal event path so
// the menu / scene repaints. Called automatically after loadStateFromBytes.
function nudgeGuestAfterRestore() {
    var c = document.getElementById('canvas');
    if (!c) return;
    var r = c.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Mouse nudge (bypasses the click-only gate).
    window.__boxedwineSyntheticMouse = true;
    try {
        c.dispatchEvent(new MouseEvent('mousemove', {
            clientX: cx, clientY: cy,
            bubbles:true, cancelable:true, view:window
        }));
    } finally {
        window.__boxedwineSyntheticMouse = false;
    }
    // Diablo's menu stays idle until an input it recognizes arrives. A
    // mousemove alone isn't enough; the menu wants arrow keys (or enter).
    // Send ArrowDown then immediately ArrowUp — net selection change = 0,
    // only one redraw cycle, no flicker.
    var fireKey = function(key, keyCode){
        ['keydown','keyup'].forEach(function(t){
            var ev = new KeyboardEvent(t, {key:key, code:key, keyCode:keyCode, which:keyCode, bubbles:true, cancelable:true});
            c.dispatchEvent(ev);
            document.dispatchEvent(ev);
        });
    };
    fireKey('ArrowDown', 40);
    fireKey('ArrowUp', 38);
}

// Load state bytes directly (not from a user-picked file). Used for the
// auto-loaded diablo_save.boxedstate so the user lands straight in gameplay.
function loadStateFromBytes(bytes) {
    if (!bytes || !bytes.length) return false;
    try {
        window.__boxedwineLoadData = bytes;
        window.__boxedwineLoadOffset = 0;
        Module._requestLoadState();
        var pollLoad = function() {
            if (!Module._isStateReady()) {
                setTimeout(pollLoad, 50);
                return;
            }
            window.__boxedwineLoadData = null;
            window.__boxedwineLoadOffset = 0;
            if (Module._isStateSuccess()) {
                console.log("[autoload] saved state applied — resuming");
                // A single gentle nudge is enough to wake the parked X11
                // render thread and force the guest to repaint the scene
                // into the now-fresh WebGL textures. More than one causes
                // visible flicker because each nudge triggers a redraw.
                setTimeout(function(){ try { nudgeGuestAfterRestore(); } catch(e){} }, 400);
            } else {
                console.warn("[autoload] saved state failed to apply");
            }
        };
        setTimeout(pollLoad, 100);
        return true;
    } catch (e) {
        console.error("[autoload] loadStateFromBytes error:", e);
        return false;
    }
}

// Auto-fetch + auto-load a pre-baked save state so first-load users don't have
// to sit through Diablo's boot sequence. Triggered once the emulator has been
// running long enough to accept a state load (the save image is a full memory
// snapshot so boxedwine must already be up).
//
//   ?autoload=1            → load diablo_save.boxedstate (in-gameplay)
//   ?autoload=menu         → load diablo_menu_save.boxedstate (at main menu;
//                            useful for reproducing menu-asset bugs)
//   ?autoload=<filename>   → load any file next to boxedwine.html
//   default                → normal Diablo boot (no restore)
(function(){
    var search = window.location.search || '';
    var m = /[?&]autoload=([^&]+)/i.exec(search);
    if (!m) return;
    var arg = decodeURIComponent(m[1]).toLowerCase();
    if (arg === '0' || arg === 'false' || arg === 'no') return;
    var stateFile;
    if (arg === '1' || arg === 'true' || arg === 'yes' || arg === 'default' || arg === 'save') {
        stateFile = 'diablo_save.boxedstate';
    } else if (arg === 'menu') {
        stateFile = 'diablo_menu_save.boxedstate';
    } else if (/\.boxedstate$/i.test(arg)) {
        stateFile = arg;
    } else {
        stateFile = 'diablo_save.boxedstate';
    }
    if (typeof fetch !== 'function') return;
    var savedBytes = null;
    var fetched = false;
    console.log('[autoload] fetching ' + stateFile);
    fetch(stateFile + '?_=' + Date.now(), {cache: 'no-store'})
        .then(function(r){
            if (!r.ok) throw new Error('no save file (' + r.status + ')');
            return r.arrayBuffer();
        })
        .then(function(buf){
            savedBytes = new Uint8Array(buf);
            fetched = true;
            console.log('[autoload] fetched ' + stateFile + ':', savedBytes.length, 'bytes');
        })
        .catch(function(e){
            fetched = true; // stop polling
            console.log('[autoload] ' + stateFile + ' not available:', e.message);
        });

    // Poll for (a) Module ready and (b) fetch complete, then apply
    var tries = 0;
    var applyWhenReady = function(){
        tries++;
        if (tries > 6000) return; // give up after ~60s
        if (!fetched) { setTimeout(applyWhenReady, 50); return; }
        if (!savedBytes) return; // nothing to load
        if (!window.Module || !Module.calledRun || typeof Module._requestLoadState !== 'function') {
            setTimeout(applyWhenReady, 100);
            return;
        }
        // Wait an extra couple seconds for wine to be running before we restore
        if (!window.__autoloadArmTime) window.__autoloadArmTime = Date.now();
        if (Date.now() - window.__autoloadArmTime < 3000) {
            setTimeout(applyWhenReady, 200);
            return;
        }
        loadStateFromBytes(savedBytes);
        savedBytes = null; // free
    };
    setTimeout(applyWhenReady, 500);
})();

// ---- FPS overlay ----
// Two counters drive this: diagPutBitsTotal (any blit, dirty or cached) for
// the actual screen update rate the user sees, and diagPutBitsDirty (frames
// the guest changed) for the "guest is drawing" rate. We show the higher of
// the two so idle adventure games (AGS post-init: dirty=0/s but cached
// re-blits at ~60Hz keep the canvas alive) don't read as "FPS 0".
// MIPS comes from the existing window title that boxedwine updates every second.
(function(){
    var fpsLine = null, mipsLine = null, overlay = null;
    var lastT = 0, lastDirty = 0, lastTotal = 0;
    var ema = 0;
    function sample() {
        if (!overlay) {
            overlay = document.getElementById('fpsOverlay');
            fpsLine = document.getElementById('fpsLine');
            mipsLine = document.getElementById('mipsLine');
        }
        if (!overlay || !fpsLine) return;
        var showFPSBox = document.getElementById('showFPS');
        var wantVisible = !showFPSBox || showFPSBox.checked;
        if (!wantVisible) {
            overlay.style.display = 'none';
            return;
        }
        if (!window.Module || !Module.calledRun || !Module._diagPutBitsDirty || !Module._diagPutBitsTotal) {
            overlay.style.display = 'none';
            return;
        }
        overlay.style.display = 'block';
        var d, t;
        try { d = Module._diagPutBitsDirty(); t = Module._diagPutBitsTotal(); } catch(e) { return; }
        var now = performance.now();
        if (lastT) {
            var dtMs = now - lastT;
            var fpsDirty = ((d - lastDirty) * 1000) / dtMs;
            var fpsTotal = ((t - lastTotal) * 1000) / dtMs;
            if (!isFinite(fpsDirty) || fpsDirty < 0) fpsDirty = 0;
            if (!isFinite(fpsTotal) || fpsTotal < 0) fpsTotal = 0;
            // Show whichever is higher: actual guest draw rate when active,
            // emscripten RAF rate when idle.
            var fps = Math.max(fpsDirty, fpsTotal);
            ema = ema ? (ema * 0.6 + fps * 0.4) : fps;
            fpsLine.textContent = 'FPS: ' + ema.toFixed(1);
        }
        lastT = now;
        lastDirty = d;
        lastTotal = t;
        // Pull MIPS out of the document title ("BoxedWine NNN MIPS")
        var m = (document.title || '').match(/(\d+)\s*MIPS/);
        if (m && mipsLine) mipsLine.textContent = 'MIPS: ' + m[1];
    }
    setInterval(sample, 500);
})();

// --- Persisted PC storage ---
// "Persist PC Storage" = walk the emscripten FS at /root (where Wine's writes
// land because boot args include `-root /root -zip boxedwine.zip`), pack the
// contents into a real zip, and stash the zip bytes in IndexedDB plus trigger
// a download so the user can unzip and verify their files are inside.
//
// On the next page load, buildExtraFileSystems() looks for this stashed zip
// and feeds it to boxedwine as an extra `-zip` overlay, so Wine sees the
// user's added folders/files on top of the stock boxedwine.zip image.
var PERSIST_DB_NAME = 'boxedwine-persisted-storage';
var PERSIST_STORE = 'zips';
var PERSIST_KEY = 'overlay';
var PERSIST_OVERLAY_NAME = 'boxedwine-overlay.zip';

function openPersistDB() {
    return new Promise(function(resolve, reject) {
        var req = indexedDB.open(PERSIST_DB_NAME, 1);
        req.onupgradeneeded = function() { req.result.createObjectStore(PERSIST_STORE); };
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
    });
}

function hasPersistedStorage() {
    return openPersistDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(PERSIST_STORE, 'readonly');
            var req = tx.objectStore(PERSIST_STORE).getKey(PERSIST_KEY);
            req.onsuccess = function() { resolve(req.result !== undefined); db.close(); };
            req.onerror = function() { reject(req.error); db.close(); };
        });
    }).catch(function(){ return false; });
}

function getPersistedOverlayBytes() {
    return openPersistDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(PERSIST_STORE, 'readonly');
            var req = tx.objectStore(PERSIST_STORE).get(PERSIST_KEY);
            req.onsuccess = function() { resolve(req.result); db.close(); };
            req.onerror = function() { reject(req.error); db.close(); };
        });
    }).catch(function(){ return null; });
}

// --- Minimal zip writer (stored method, no compression) ---
// The emulator's minizip layer reads these fine, and they're trivially
// inspectable with `unzip -l` or Finder / Explorer double-click.
var _zipCrcTable = null;
function _zipCrc32(data) {
    if (!_zipCrcTable) {
        _zipCrcTable = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            _zipCrcTable[n] = c;
        }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < data.length; i++) crc = _zipCrcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Merge the stock boxedwine.zip (already loaded into the emscripten FS at
// `/` by buildBrowserFileSystem) with extra "stored" entries, preserving the
// original compressed data verbatim so we never need a deflate decoder.
// Duplicate entry names → the extra entry wins (placed later in the CD).
function buildMergedZip(originalZip, extraEntries) {
    if (!originalZip || originalZip.length < 22) {
        return buildZipStored(extraEntries);
    }
    // Locate EOCD (end-of-central-directory) by scanning back up to 64KB.
    var n = originalZip.length;
    var view = new DataView(originalZip.buffer, originalZip.byteOffset, originalZip.length);
    var eocdOff = -1;
    var maxBack = Math.max(0, n - 65557);
    for (var i = n - 22; i >= maxBack; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocdOff = i; break; }
    }
    if (eocdOff < 0) return buildZipStored(extraEntries);
    var oldCdSize = view.getUint32(eocdOff + 12, true);
    var oldCdOff = view.getUint32(eocdOff + 16, true);
    var oldEntryCount = view.getUint16(eocdOff + 10, true);
    if (oldCdOff + oldCdSize > n) return buildZipStored(extraEntries);

    var originalData = originalZip.subarray(0, oldCdOff);   // [local headers + data]
    var originalCD = originalZip.subarray(oldCdOff, oldCdOff + oldCdSize);

    // Encode the new entries' local headers + data, and their central
    // directory records with offsets relative to start of file, starting at
    // originalData.length.
    var extraParts = [];
    var extraCDParts = [];
    var curOff = originalData.length;

    for (var e = 0; e < extraEntries.length; e++) {
        var ent = extraEntries[e];
        var filename = new TextEncoder().encode(ent.name);
        var data = ent.data || new Uint8Array(0);
        var crc = _zipCrc32(data);
        var size = data.length;

        var lh = new Uint8Array(30 + filename.length);
        var lv = new DataView(lh.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, 0, true);
        lv.setUint16(12, 0x21, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);
        lv.setUint32(22, size, true);
        lv.setUint16(26, filename.length, true);
        lv.setUint16(28, 0, true);
        lh.set(filename, 30);
        extraParts.push(lh);
        if (size) extraParts.push(data);

        var cd = new Uint8Array(46 + filename.length);
        var cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 30, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, filename.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        var isDir = ent.name.charAt(ent.name.length - 1) === '/';
        cv.setUint32(38, isDir ? 0x41ED0010 : 0x81A40000, true);
        cv.setUint32(42, curOff, true);
        cd.set(filename, 46);
        extraCDParts.push(cd);

        curOff += lh.length + size;
    }

    // Assemble: original data + extra entries + (old CD + new CD) + new EOCD
    var cdStart = curOff;
    var mergedCdSize = originalCD.length;
    for (var k = 0; k < extraCDParts.length; k++) mergedCdSize += extraCDParts[k].length;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    var totalEntries = oldEntryCount + extraEntries.length;
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, totalEntries, true);
    ev.setUint16(10, totalEntries, true);
    ev.setUint32(12, mergedCdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);

    var parts = [originalData].concat(extraParts, [originalCD], extraCDParts, [eocd]);
    var total = 0;
    for (var p = 0; p < parts.length; p++) total += parts[p].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var q = 0; q < parts.length; q++) { out.set(parts[q], pos); pos += parts[q].length; }
    return out;
}

function buildZipStored(entries) {
    // entries: [{ name, data }] — data empty for directories, name ends with '/' for dirs.
    var parts = [];
    var centralDir = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var filename = new TextEncoder().encode(e.name);
        var data = e.data || new Uint8Array(0);
        var crc = _zipCrc32(data);
        var size = data.length;

        // Local file header
        var header = new Uint8Array(30 + filename.length);
        var hv = new DataView(header.buffer);
        hv.setUint32(0, 0x04034b50, true);
        hv.setUint16(4, 20, true);       // version needed
        hv.setUint16(6, 0x0800, true);   // UTF-8 filename flag
        hv.setUint16(8, 0, true);        // compression = stored
        hv.setUint16(10, 0, true);       // mod time
        hv.setUint16(12, 0x21, true);    // mod date = 1980-01-01
        hv.setUint32(14, crc, true);
        hv.setUint32(18, size, true);
        hv.setUint32(22, size, true);
        hv.setUint16(26, filename.length, true);
        hv.setUint16(28, 0, true);       // extra length
        header.set(filename, 30);
        parts.push(header);
        if (size) parts.push(data);

        // Central directory entry
        var cd = new Uint8Array(46 + filename.length);
        var cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 30, true);       // version made by: 3.0 = UNIX
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, filename.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        var isDir = e.name.charAt(e.name.length - 1) === '/';
        cv.setUint32(38, isDir ? 0x41ED0010 : 0x81A40000, true); // rwxr-xr-x dir or rw-r--r-- file
        cv.setUint32(42, offset, true);
        cd.set(filename, 46);
        centralDir.push(cd);

        offset += header.length + size;
    }

    var cdStart = offset;
    for (var j = 0; j < centralDir.length; j++) { parts.push(centralDir[j]); offset += centralDir[j].length; }
    var cdSize = offset - cdStart;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);
    parts.push(eocd);

    var total = 0;
    for (var p = 0; p < parts.length; p++) total += parts[p].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var q = 0; q < parts.length; q++) { out.set(parts[q], pos); pos += parts[q].length; }
    return out;
}

// Walk an emscripten-FS directory, collecting entries relative to rootPath.
function collectFsEntries(rootPath) {
    var results = [];
    function walk(path, rel) {
        var names;
        try { names = FS.readdir(path); } catch(e) { return; }
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (n === '.' || n === '..') continue;
            var full = path === '/' ? '/' + n : path + '/' + n;
            var relName = rel ? rel + '/' + n : n;
            var stat;
            try { stat = FS.lstat(full); } catch(e) { continue; }
            var mode = stat.mode & 0xF000;
            if (mode === 0x4000) { // directory
                results.push({ name: relName + '/', data: null });
                walk(full, relName);
            } else if (mode === 0x8000) { // regular file
                var data;
                try { data = FS.readFile(full); } catch(e) { continue; }
                results.push({ name: relName, data: data });
            }
            // skip symlinks and others
        }
    }
    walk(rootPath, '');
    return results;
}

function persistPcStorage() {
    if (!isRunning) {
        alert("Emulator is not running.");
        return;
    }
    var btn = document.getElementById('persistpcbtn');
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Persisting...";

    // Flush IDBFS so /root reflects the latest writes, then build a merged
    // zip (stock boxedwine.zip entries + user's additions) and download it.
    // Also stash in IndexedDB so the next page load auto-applies the overlay.
    FS.syncfs(false, function(err) {
        try {
            var entries = collectFsEntries(ROOT);
            if (entries.length === 0) {
                btn.disabled = false;
                btn.textContent = originalText;
                alert("No PC storage changes to persist yet.\n\n" +
                      "Tip: create a folder or file inside the emulator first, then press this button again.");
                return;
            }

            // Read the stock zip (loaded into emscripten FS at boot).
            var originalZip = null;
            try { originalZip = FS.readFile("/" + Config.rootZipFile); } catch(_) {}
            var merged = originalZip
                ? buildMergedZip(originalZip, entries)
                : buildZipStored(entries);

            // Save to IndexedDB so the overlay applies on next reload.
            openPersistDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx = db.transaction(PERSIST_STORE, 'readwrite');
                    tx.objectStore(PERSIST_STORE).put(merged, PERSIST_KEY);
                    tx.oncomplete = function() { db.close(); resolve(); };
                    tx.onerror = function() { db.close(); reject(tx.error); };
                });
            }).then(function() {
                // Trigger a download so the user can drop the new zip into
                // project/emscripten/web/boxedwine.zip (replacing the stock
                // one) if they want the change to be permanent on disk.
                var blob = new Blob([merged], {type: "application/zip"});
                var link = document.createElement('a');
                link.download = Config.rootZipFile; // "boxedwine.zip"
                link.href = URL.createObjectURL(blob);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(link.href);

                btn.disabled = false;
                btn.textContent = "Persisted ✓";
                setTimeout(function(){ btn.textContent = originalText; }, 1500);
                document.getElementById('clearpersistbtn').style.display = '';
                console.log("Persisted " + entries.length + " new entries into merged " +
                    Config.rootZipFile + " (" + (merged.length/1024/1024).toFixed(2) + " MB). " +
                    "Downloaded a copy; also stashed in IndexedDB for auto-reload.");
            }).catch(function(e) {
                btn.disabled = false;
                btn.textContent = originalText;
                console.error("Error persisting:", e);
                alert("Error persisting: " + (e && e.message ? e.message : e));
            });
        } catch (e) {
            btn.disabled = false;
            btn.textContent = originalText;
            console.error("Error building persist zip:", e);
            alert("Error building persist zip: " + (e && e.message ? e.message : e));
        }
    });
}

function clearPersistedPcStorage() {
    if (!confirm("Clear the persisted PC storage overlay? Next page load will boot from stock boxedwine.zip only.")) return;
    openPersistDB().then(function(db) {
        var tx = db.transaction(PERSIST_STORE, 'readwrite');
        tx.objectStore(PERSIST_STORE).delete(PERSIST_KEY);
        tx.oncomplete = function() {
            db.close();
            document.getElementById('clearpersistbtn').style.display = 'none';
            alert("Persisted PC storage cleared. Reload to get a fresh boot.");
        };
        tx.onerror = function() { db.close(); alert("Failed to clear: " + tx.error); };
    });
}

// No-op kept for backwards compatibility — the previous full-heap auto-load
// has been replaced by the zip overlay, which is installed by
// initialSetup() before boxedwine starts.
function autoLoadPersistedPcStorage() {}

function ensureDir(dir) {
    if (dir === '/' || dir === '') return;
    var parts = dir.split('/');
    var current = '';
    for (var i = 0; i < parts.length; i++) {
        if (parts[i] === '') continue;
        current += '/' + parts[i];
        try { FS.mkdir(current); } catch(e) {}
    }
}


function toggleConsole() {
    var el = document.getElementById('showConsole');
    var console = document.getElementById('output');
    if(el.checked){
        console.style.display = '';
    }else{
        console.style.display = 'none';
    }
}
function toggleSound() {
    var el = document.getElementById('soundToggle');
    Config.isSoundEnabled = el.checked;
}
function toggleDirectory(item) {
	var itemWidget =document.getElementById(item);
	if(itemWidget!=null){
		if(itemWidget.style.display=='none'){//show
			itemWidget.style.display="";
			document.getElementById(item+'-expand').style.display="none";
			document.getElementById(item+'-contract').style.display="";
		}else{//hide
			itemWidget.style.display="none";
			document.getElementById(item+'-expand').style.display="";
			document.getElementById(item+'-contract').style.display="none";
		}
	}
}
function getParameter(inputKey) {
    var retVal="";
    var replacementParameters = Config.urlParams;
    var url = replacementParameters.length > 0 ? "?" + replacementParameters : window.location.href;
    var index = url.indexOf("?")+1;
    if(index > 0){
        var paramStr = url.substring(index);
        var params = paramStr.split("&");
        for(var x=0;x<params.length;x++){
            var param = params[x];
            var kv = param.split("=");
            var key = kv[0];
            if(key === inputKey){
                retVal = kv[1];
                break;
            }
        }
    }
    var hashIndex = retVal.lastIndexOf('#');
    if(hashIndex > 0 ) {
        retVal = retVal.substring(0, hashIndex);
    }
    return retVal;
}
var index = 0;
var files = [];
var selectedItem;
var selectedFilename;
function select(index, dir, filename) {
	if(selectedItem != null){
		selectedItem.style.backgroundColor = "";
	}
	selectedItem = document.getElementById(index + '-data');
	selectedItem.style.backgroundColor="#94c2c5";
	var fullpath = dir;
	if(filename != null){
		fullpath = fullpath + filename;
	}
	document.getElementById('selectedItem').value = fullpath
	selectedFilename = filename
}
function endsWith(str, suffix) {
    return str.indexOf(suffix, str.length - suffix.length) !== -1;
}
function extract() {
	let file = document.getElementById('selectedItem').value;
	if(file != null && file.length > 0 && files.length > 1) {
        if(endsWith(file,"/")){
			return;
        }
        let data = FS.readFile(file, { encoding: 'binary' });
		let blob =  new Blob([data], {type: "octet/stream"});
		
      	let link = document.createElement('a');
      	link.setAttribute('download', selectedFilename);
      	link.setAttribute('href', window.URL.createObjectURL(blob));
      	document.body.appendChild(link);
      	link.click();
      	document.body.removeChild(link);
	}
}
function leaf(entry) {
    index++;
	var text = "<tr><td ><span id=\"" + index + "-data\" onclick=\"select(" + index + ",'" + entry.dir + "','" + entry.filename + "')\">" + entry.filename + "</span></td></tr>";
	return text;
}
function branch(entries) {
	var item = entries[index];
    index++;
	var dir = item.dir;
    var dirName = dir.substring(0, dir.length - 1);
    dirName = dirName.substring(dirName.lastIndexOf("/")+1,dirName.length);
	var text = "<tr>";
    text = text + "<td>";
	text = text + "<span id=\"" + index + "-expand\"><a onclick=\"toggleDirectory('" + index + "')\"><strong>+</strong></a></span>";
    text = text + "<span id=\"" + index + "-contract\" style=\"display:none;\"><a onclick=\"toggleDirectory('" + index + "')\"><strong>-</strong></a></span>";
    text = text + "<span id=\"" + index + "-data\" onclick=\"select(" + index + ",'" + dir + "', null)\">[" + dirName + "]</span>";
    text = text + "<div id='" + index + "' style=\"display:none;\">";
    text = text + "<table>";
    while(index < entries.length){
    	var nextItem = entries[index];
    	if(nextItem.dir === item.dir){
    		text = text + leaf(nextItem);
    	}else if(parentDir(nextItem.dir) === item.dir){
    		text = text + branch(entries, index);
    	}else{
    		break;
    	}
    }
    text = text + "</table>";
    text = text + "</div>";
	text = text + "</td>";
	text = text + "</tr>";
	return text;
}
function parentDir(childDir) {
    if(endsWith(childDir,"/")){
        childDir = childDir.substring(0,childDir.length - 1);
    }
    return childDir.substring(0, childDir.lastIndexOf('/') + 1);
}
function buildGetFilesModal() {
	buildGetFilesModalForFolder(Config.d_drive);
}
function buildGetFilesModalForFolder(folder) {
    document.getElementById('modalLink').click();
    let root = document.getElementById('tree');
    //reset
    document.getElementById('selectedItem').value = "";
    selectedFilename = null;
	files = [];
    root.innerHTML = "";
    index = 0;
	readFiles(folder + "/", files);

	let contents = "<table>" + branch(files) + "</table>";
	document.getElementById('loadStatus').style.display="none";
	root.innerHTML = contents;
	toggleDirectory('1');
}
function readFiles(currentDir, files) {
    console.log("adding directory: " + currentDir);
    files.push({dir : currentDir, filename : ""});
    var entries = FS.readdir(currentDir).filter(function(param) {
        return param !== "." && param !== "..";
    });
    entries.forEach(function(entry) {
        var fileEntry = FS.lookupPath(currentDir + entry, { follow: true });
        if (fileEntry.node.isFolder) {
            readFiles(currentDir + entry + "/", files);
        }else{
            console.log("adding file: " + currentDir + entry);
            files.push({dir : currentDir, filename : entry});
        }
    });
}


/** code from https://github.com/Rob--W/zipinfo.js MIT license
 **/
function getZipEntries(data) {
  var view = new DataView(data.buffer, data.byteOffset, data.length);
  var entriesLeft = 0;
  var offset = 0;
  var endoffset = data.length;
  // Find EOCD (0xFFFF is the maximum size of an optional trailing comment).
  for (var i = data.length - 22, ii = Math.max(0, i - 0xFFFF); i >= ii; --i) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b &&
      data[i + 2] === 0x05 && data[i + 3] === 0x06) {
        endoffset = i;
        offset = view.getUint32(i + 16, true);
        entriesLeft = view.getUint16(i + 8, true);
        break;
      }
  }
  var entries = [{
    directory: true,
    filename: '/',
    uncompressedSize: 0,
    centralDirectoryStart: offset,
  }];
  if (offset >= data.length || offset <= 0) {
    // EOCD not found or malformed. Try to recover if possible (the result is
    // most likely going to be incomplete or bogus, but we can try...).
    offset = -1;
    entriesLeft = 0xFFFF;
    while (++offset < data.length && data[offset] !== 0x50 &&
      data[offset + 1] !== 0x4b && data[offset + 2] !== 0x01 &&
        data[offset + 3] !== 0x02);
  }
  endoffset -= 46;  // 46 = minimum size of an entry in the central directory.
  while (--entriesLeft >= 0 && offset < endoffset) {
    if (view.getUint32(offset) != 0x504b0102) {
      break;
    }
    var bitFlag = view.getUint16(offset + 8, true);
    var uncompressedSize = view.getUint32(offset + 24, true);
    var fileNameLength = view.getUint16(offset + 28, true);
    var extraFieldLength = view.getUint16(offset + 30, true);
    var fileCommentLength = view.getUint16(offset + 32, true);
    var filename = data.subarray(offset + 46, offset + 46 + fileNameLength);
    var utfLabel = (bitFlag & 0x800) ? 'utf-8' : 'ascii';
    filename = new TextDecoder(utfLabel).decode(filename);
    entries.push({
      directory: filename.endsWith('/'),
      filename: filename,
      uncompressedSize: uncompressedSize,
    });
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
};
