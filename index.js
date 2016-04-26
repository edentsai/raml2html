'use strict';

var raml2obj = require('raml2obj');
var pjson = require('./package.json');
var Q = require('q');

/**
 * Render the source RAML object using the config's processOutput function
 *
 * The config object should contain at least the following property:
 * processRamlObj: function that takes the raw RAML object and returns a promise with the rendered HTML
 *
 * @param {(String|Object)} source - The source RAML file. Can be a filename, url, contents of the RAML file,
 * or an already-parsed RAML object.
 * @param {Object} config
 * @param {Function} config.processRamlObj
 * @returns a promise
 */
function render(source, config) {
  config = config || {};
  config.raml2HtmlVersion = pjson.version;

  return raml2obj.parse(source).then(function (ramlObj) {
    ramlObj.config = config;

    if (config.processRamlObj) {
      return config.processRamlObj(ramlObj).then(function (html) {
        if (config.postProcessHtml) {
          return config.postProcessHtml(html);
        }
        return html;
      });
    }

    return ramlObj;
  });
}

/**
 * @param {String} [mainTemplate] - The filename of the main template, leave empty to use default templates
 * @param {String} [templatesPath] - Optional, by default it uses the current working directory
 * @returns {{processRamlObj: Function, postProcessHtml: Function}}
 */
function getDefaultConfig(mainTemplate, templatesPath) {
  if (!mainTemplate) {
    mainTemplate = './lib/template.nunjucks';

    // When using the default template, make sure that Nunjucks isn't
    // using the working directory since that might be anything
    templatesPath = __dirname;
  }

  return {
    processRamlObj: function (ramlObj) {
      var nunjucks = require('nunjucks');
      var markdown = require('nunjucks-markdown');
      var marked = require('marked');
      var ramljsonexpander = require('raml-jsonschema-expander');
      var renderer = new marked.Renderer();
      renderer.table = function (thead, tbody) {
        // Render Bootstrap style tables
        return '<table class="table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
      };

      // Setup the Nunjucks environment with the markdown parser
      var env = nunjucks.configure(templatesPath, { watch: false });
      markdown.register(env, function (md) {
        return marked(md, { renderer: renderer });
      });

      // Add extra function for finding a security scheme by name
      ramlObj.securitySchemeWithName = function (name) {
        for (var index = 0; index < ramlObj.securitySchemes.length; ++index) {
          if (ramlObj.securitySchemes[index][name] !== null) {
            return ramlObj.securitySchemes[index][name];
          }
        }
      };

      // Get the root type of a type.
      var getRootType = function (type) {
        if (type.type.length > 1) {
          return 'object';
        }
        var parent = type.type[0];
        for (var index = 0; index < ramlObj.types.length; ++index) {
          if (typeof ramlObj.types[index][parent] !== 'undefined') {
            return getRootType(ramlObj.types[index][parent]);
          }
        }
        return type.type[0];
      };

      // Add extra function for finding a type by name
      ramlObj.typeWithName = function (name) {
        for (var index = 0; index < ramlObj.types.length; ++index) {
          if (typeof ramlObj.types[index][name] !== 'undefined') {
            var type = ramlObj.types[index][name];
            return {
              type: type,
              rootType: getRootType(type),
            };
          }
        }
      };

      /**
       * Add extra function for finding the properties of a type recursively.
       *
       * @param {Object} [type] - The type object with all it's properties.
       * @param {String} [rootType] - Optional, type that will overwrite the type of the returned object.
       * @returns {{ properties: {}, ...}} A type representation with all its properties.
       */
      ramlObj.propertiesOfType = function (type, rootType) {
        var properties = {
          properties: {},
        };

        for (var property in type.properties) {
          if (type.properties.hasOwnProperty(property)) {
            properties.properties[property] = type.properties[property];
          }
        }

        var availableProperties = [
          'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
          'format', 'multipleOf', 'fileTypes',
        ];

        for (var i = 0; i < availableProperties.length; ++i) {
          if (typeof type[availableProperties[i]] !== 'undefined') {
            properties[availableProperties[i]] = type[availableProperties[i]];
          }
        }

        for (var index = 0; index < type.type.length; ++index) {
          var parent = ramlObj.typeWithName(type.type[index]);
          if (typeof parent !== 'undefined') {
            var parentProperties = ramlObj.propertiesOfType(parent.type);
            for (var parentProperty in parentProperties.properties) {
              if (parentProperties.properties.hasOwnProperty(parentProperty)) {
                properties.properties[parentProperty] = parentProperties.properties[parentProperty];
              }
            }

            for (var index2 = 0; index2 < availableProperties.length; ++index2) {
              if (typeof parentProperties[availableProperties[index2]] !== 'undefined') {
                if (typeof properties[availableProperties[index2]] === 'undefined') {
                  properties[availableProperties[index2]] = parentProperties[availableProperties[index2]];
                }
              }
            }
          }
        }

        if (typeof rootType !== 'undefined') {
          properties.type = rootType;
        }

        return properties;
      };

      // Find and replace the $ref parameters.
      ramlObj = ramljsonexpander.expandJsonSchemas(ramlObj);

      // Render the main template using the raml object and fix the double quotes
      var html = env.render(mainTemplate, ramlObj);
      html = html.replace(/&quot;/g, '"');

      // Return the promise with the html
      return Q.fcall(function () {
        return html;
      });
    },

    postProcessHtml: function (html) {
      // Minimize the generated html and return the promise with the result
      var Minimize = require('minimize');
      var minimize = new Minimize({ quotes: true });

      var deferred = Q.defer();

      minimize.parse(html, function (error, result) {
        if (error) {
          deferred.reject(new Error(error));
        } else {
          deferred.resolve(result);
        }
      });

      return deferred.promise;
    }
  };
}

module.exports = {
  getDefaultConfig: getDefaultConfig,
  render: render
};

if (require.main === module) {
  console.log('This script is meant to be used as a library. You probably want to run bin/raml2html if you\'re looking for a CLI.');
  process.exit(1);
}
