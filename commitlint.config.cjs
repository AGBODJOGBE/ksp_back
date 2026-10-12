module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Le scope est le nom du service, de la bibliothèque ou du domaine touché (identity, platform, contracts, ci…).
    'scope-empty': [1, 'never'],
  },
};
