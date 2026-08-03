/**
 * Admin actions
 * 
 * A collections of admin functions for manipulating the data in 3rd party databases.
 * DB: Top Echelon, Notion
 * 
 * env vars required: None
 */

/**
 * Gets the id of the "Delete Me" tag or creates it if it doesn't exist
 * @param {string} accessToken 
 * @returns {string} tagId
 */
async function getDeleteTagTE(accessToken) {
    const tagId = "";
    return tagId;
}

/**
 * Creates a dictionary of duplicate people records on Top Echelon.
 * @param {string} accessToken 
 * @returns {Object} a dictionary of duplicate people and their IDs
 */
export async function findDuplicatesTE(accessToken) {
    const duplicates = {};
    return duplicates;
}

/**
 * Marks a defined list of duplicate people records for deletion.
 * @param {string} accessToken 
 * @param {Object} duplicates 
 * @returns {Object} the status and a status message of the check
 */
export async function markDuplicatesTE(accessToken, duplicates){
    const success = true;
    const message = "All good";
    return {
        "status": success,
        "message": message
    }
}