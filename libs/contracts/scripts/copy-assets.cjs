// Copie les fichiers .proto et les schémas d'événements dans dist/, pour que les services
// les chargent à l'exécution (gRPC proto-loader) sans dépendre de l'arborescence du dépôt.
const { cpSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..', '..', '..', 'contracts');
cpSync(join(root, 'proto'), join(__dirname, '..', 'dist', 'proto'), { recursive: true });
cpSync(join(root, 'events'), join(__dirname, '..', 'dist', 'events'), { recursive: true });
