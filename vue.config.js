// vue.config.js
const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  publicPath: './',
  configureWebpack: {
    plugins: [
      new webpack.DefinePlugin({
        CESIUM_BASE_URL: JSON.stringify('')
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'node_modules/cesium/Build/Cesium/Workers', to: 'Workers' },
          { from: 'node_modules/cesium/Build/Cesium/ThirdParty', to: 'ThirdParty' },
          { from: 'node_modules/cesium/Build/Cesium/Assets', to: 'Assets' },
          { from: 'node_modules/cesium/Build/Cesium/Widgets', to: 'Widgets' }
        ]
      })
    ],
    resolve: {
      fallback: { https: false, http: false, zlib: false }
    },
    module: {
      unknownContextCritical: false,
      unknownContextRegExp: /\/cesium\/cesium\/Source\/Core\/buildModuleUrl\.js/
    }
  }
};