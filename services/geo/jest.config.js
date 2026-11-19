module.exports = {
  ...require('../../jest.preset.js'),
  rootDir: __dirname,
  // Seuil minimal de couverture (pnpm test:coverage, en CI) : couverture mesurée le 2026-11-19 sans
  // base ni broker (tests d'intégration ignorés), arrondie à l'entier inférieur, moins 2 points.
  // À relever quand la couverture progresse, jamais à baisser.
  coverageThreshold: {
    global: { statements: 92, branches: 83, functions: 90, lines: 94 },
  },
};
