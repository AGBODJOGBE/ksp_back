// Point d'entrée séparé : à charger avant NestJS pour que les bibliothèques soient instrumentées.
module.exports = require('./dist/telemetry/telemetry');
