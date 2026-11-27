const { rmSync, copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

rmSync(join(__dirname, '..', 'dist'), { recursive: true, force: true });

// Release-owned assets are copied from their single source of truth.
const assets = join(__dirname, '..', 'assets');
mkdirSync(assets, { recursive: true });
copyFileSync(join(__dirname, '../../..', 'pricing.yaml'), join(assets, 'pricing.yaml'));
copyFileSync(join(__dirname, '../../..', 'NOTICE'), join(__dirname, '..', 'NOTICE'));
copyFileSync(join(__dirname, '../../..', 'THIRD_PARTY_NOTICES.md'), join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'));
