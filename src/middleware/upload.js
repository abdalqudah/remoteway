// Single-file uploads kept in memory (max 10 MB), then handed to the storage layer.
const multer = require('multer');
const { E } = require('../core/errors');
const { verifyCsrfAfterUpload } = require('./web');

const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 30 } });

const bigParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 10 } });

const singleFile = (field = 'file', { big = false } = {}) => [
  (req, res, next) => (big ? bigParser : parser).single(field)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(E.validation({ file: big ? 'The package is larger than 30 MB.' : 'Files must be 10 MB or smaller.' }));
    return next(E.validation({ file: 'The upload could not be read.' }));
  }),
  verifyCsrfAfterUpload,
];

/** Several named files in one form (e.g. a stamp image and a signed document), 10 MB each. */
const multiParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4, fields: 30, fieldSize: 600 * 1024 } });
const someFiles = (names) => [
  (req, res, next) => multiParser.fields(names.map((name) => ({ name, maxCount: 1 })))(req, res, (err) => {
    if (!err) {
      req.filesByName = Object.fromEntries(Object.entries(req.files || {}).map(([k, v]) => [k, v[0]]));
      return next();
    }
    if (err.code === 'LIMIT_FILE_SIZE') return next(E.validation({ file: 'Files must be 10 MB or smaller.' }));
    return next(E.validation({ file: 'The upload could not be read.' }));
  }),
  verifyCsrfAfterUpload,
];

module.exports = { singleFile, someFiles };
