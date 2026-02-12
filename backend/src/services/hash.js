const { createHash } = require('crypto');

function createContentHash(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

module.exports = {
  createContentHash
};
