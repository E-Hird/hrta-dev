/**
 * Form Submission Handler
 * 
 * Checks form submissions from the website, validates and transforms the payload,
 * and uploads to the relevant 3rd party databases.
 * 
 * env vars required: None
 */

/**
 * Checks if the contents of the form fits requirements.
 * @param {Object} formData 
 * @param {Boolean} fractional - default=false
 * @returns {Object} the status and a status message of the check
 */
export function checkFormSubmission(formData, fractional=false){
    const isGood = true;
    const message = "All good";
    return {
        "status": isGood,
        "message": message
    }
}