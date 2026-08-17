/**
 * Utility Functions
 * 
 * A collection of utility functions for the project.
 * 
 * Required env vars: None
 */

/**
 * Sets up a timer for retrying a request
 * @param {*} retryAfterHeader 
 * @returns A promise to be awaited.
 */
export function retryTimer(retryAfterHeader){
    var waitMs;
    // Generate timer
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader) + 5;
        waitMs = Number.isNaN(seconds)
            ? new Date(retryAfterHeader).getTime() - Date.now()
            : seconds * 1000;
    } else {
        waitMs = 2 * 1000;
    }

    // If timer is too long return false (generate an error)
    if (waitMs > 120000){
        return false
    }

    console.warn(`Retry required, waiting ${waitMs}ms`);
    return new Promise(resolve => setTimeout(resolve, waitMs));
}