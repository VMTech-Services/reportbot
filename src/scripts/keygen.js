module.exports = function generateKey(length = 6, parts = 4) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    function getRandomChar() {
        const array = new Uint32Array(1);
        crypto.getRandomValues(array);
        return chars[array[0] % chars.length];
    }

    function getPart() {
        return Array.from({ length }, getRandomChar).join("");
    }

    return Array.from({ length: parts }, getPart).join("-");
}