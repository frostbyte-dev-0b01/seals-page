const GODOT_CONFIG = {
    "args": [],
    "canvasResizePolicy": 2,
    "executable": "three-seals",
    "experimentalVK": false,
    "fileSizes": {
        "three-seals.pck": 14917136,
        "three-seals.wasm": 38057390
    },
    "focusCanvas": true,
    "gdextensionLibs": []
};

(function () {
    const entryScreen = document.getElementById('entry-screen');
    const startButton = document.getElementById('start-button');
    const canvas = document.getElementById('canvas');

    const configWithProgress = {
        ...GODOT_CONFIG,
        onProgress: function (current, total) {
            if (total > 0) {
                const percent = Math.floor((current / total) * 100);
                startButton.textContent = `Loading ${percent}%...`;
            }
        }
    };


    const engine = new Engine(configWithProgress);

    let fullyPreloaded = false;

    // Fully preload and initialize the engine
    async function preloadEngine() {
        try {
            startButton.textContent = 'Loading...';
            startButton.disabled = true;

            // Load and preload everything
            await engine.load('three-seals');
            await engine.preloadFile('three-seals.pck');

            // Initialize without starting
            await engine.init('three-seals');

            fullyPreloaded = true;
            startButton.textContent = 'Start Game';
            startButton.disabled = false;
        } catch (err) {
            console.error('Failed to preload engine:', err);
            startButton.textContent = 'Error Loading Game';
        }
    }

    // Start preloading immediately
    preloadEngine();

    // Handle start button click
    startButton.addEventListener('click', async function () {
        if (!fullyPreloaded) {
            console.error('Engine not fully loaded yet');
            return;
        }

        try {
            // Start with the main pack argument
            await engine.start({
                'args': ['--main-pack', 'three-seals.pck']
            });
            // Fade out entry screen
            entryScreen.style.opacity = '0';
            entryScreen.style.transition = 'opacity 0.5s ease-out';

            // Remove from DOM after fade completes
            setTimeout(() => {
                entryScreen.classList.add('hidden');
            }, 500);

        } catch (err) {
            console.error('Failed to start game:', err);
            entryScreen.classList.remove('hidden');
            startButton.textContent = 'Retry';
        }
    });
})();