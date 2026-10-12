const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Чистые функции сборки (assemblyKitScan.js и т.п.) берём из веб-клиента, чтобы логика не расходилась.
config.watchFolders = [...(config.watchFolders || []), path.resolve(__dirname, '../client/src/utils')];

module.exports = config;
