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

module.exports = { singleFile };
