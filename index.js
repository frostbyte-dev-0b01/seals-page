(function() {
  const entryScreen = document.getElementById('entry-screen');
  const startButton = document.getElementById('start-button');

  const GODOT_CONFIG = {
    canvas: canvas,
    executable: 'three-seals',
    mainPack: 'three-seals.pck',
    args: [],
    canvasResizePolicy: 2
    };

  engine = new Engine(GODOT_CONFIG);

  startButton.textContent = 'Start Game';

  // Fully preload and initialize the engine
  async function preloadEngine() {
    try {
      // Load and preload everything
      await engine.load('three-seals');
      await engine.preloadFile('three-seals.pck');
      await engine.init('three-seals');
    } catch (err) {
      console.error('Failed to preload engine:', err);
      startButton.textContent = 'Error Loading Game';
    }
  }

  // Start preloading immediately
  preloadEngine();

  // Handle start button click
  startButton.addEventListener('click', async function() {
    try {
      startButton.textContent = 'Loading...';
      startButton.disabled = true;

      // Allow the text to render before heavy work
      await new Promise(resolve => setTimeout(resolve, 50));

      await engine.start({
        'args': ['--main-pack', 'three-seals.pck']
      });

      entryScreen.style.transition = 'opacity 0.5s ease-out';
      entryScreen.style.opacity = '0';
      setTimeout(() => entryScreen.classList.add('hidden'), 500);

    } catch (err) {
      console.error('Failed to start game:', err);
      entryScreen.classList.remove('hidden');
      startButton.textContent = 'Retry';
    }
  });
})();
