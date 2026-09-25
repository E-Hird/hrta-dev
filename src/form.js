/**
 * Form Submission Handler
 * 
 * Checks form submissions from the website, validates and transforms the payload,
 * and uploads to the relevant 3rd party databases.
 * 
 * env vars required: None
 */

import { addToHotlistTE, parseFromResumeTE, findRecordTE, updateRecordTE, addAttachmentTE } from "./database-actions.js";
import { uid, retryTimer, getDateString } from "./utilities.js";

/**
 * Checks if the contents of the form fits requirements.
 * @param {FormData} formData 
 * @param {Boolean} fractional - default=false
 * @returns {Object} the status and a status message of the check
 */
function checkFormSubmission(formData, fractional=false){
    // List of fields that should be present in the formData
    const fields = ["fname", "lname", "email", "linkedIn", "resume", "city", "state", "country", "jobTitle", "industry", "company",
        "boss", "responsibilities", "teamsAndFunctions", "challengesSolved", "fixBuildImprove", "outcomes", "problemSolving",
        "keySystems", "workInterest", "companyInterest", "workTypePreference",
    ]
    var status = 200;
    // Check if any fields are missing
    var missingFieldString = ""
    for (let field of fields){
        if (!formData.has(field)){
            status = 400;
            missingFieldString += `${field}, `
        }
    }
    if (status === 400){
        return {
            "status": 400,
            "message": `Missing fields: ${missingFieldString}`
        }
    }

    // Check that 'resume' contains a file
    const resumeFile = formData.get("resume")
    if (!(resumeFile instanceof File)){
        return {
            "status": 400,
            "message": `File missing`
        }
    }

    // Check that the linkedin link is for a linkedin profile
    const linkedInProfile = formData.get("linkedIn");
    if (!linkedInProfile.includes("www.linkedin.com/in/")){
        return {
            "status": 400,
            "message": "Link to LinkedIn profile is malformed"
        }
    }

    // Check that work preference is one of the given options
    const options = ["On site/In office", "Hybrid", "Remote"]
    if (!(options.includes(formData.get("workTypePreference")))){
        return {
            "status": 400,
            "message": "Invalid option chosen for work type preference."
        }
    }

    // If all tests are passed then return a success
    return {
        "status": 200,
        "message": "All good"
    }
}

/**
 * Creates a text file containing responses to form questions
 * @param {Object} formData 
 * @returns {FormData} Delivery form
 */
function createResponseFile(formData){
    const content = `
    Name: ${formData.get("fname")} ${formData.get("lname")}
    Email: ${formData.get("email")}
    LinkedIn: ${formData.get("linkedIn")}
    Location: ${formData.get("city")}, ${formData.get("state")}, ${formData.get("country")}
    Job Title: ${formData.get("jobTitle")}
    Industry: ${formData.get("industry")}
    Company: ${formData.get("company")}
    Boss: ${formData.get("boss")}
    
    Primary Responsibilities?
        ${formData.get("responsibilities")}
    
    What Teams and Functions did you own?
        ${formData.get("teamsAndFunctions")}
    
    What challenges did you solve?
        ${formData.get("challengesSolved")}
    
    What did you fix, build or improve?
        ${formData.get("fixBuildImprove")}
    
    List 2-4 outcomes you delivered?
        ${formData.get("outcomes")}

    What type of problems do you feel confident solving?
        ${formData.get("problemSolving")}
    
    What key systems, tools or platforms have you used?
        ${formData.get("keySystems")}
    
    What type of work interests you?
        ${formData.get("workInterest")}
    
    What type of company are you interested in?
        ${formData.get("companyInterest")}
    
    Work Preference: ${formData.get("workTypePreference")}
    `;
    // Turn text into a file format
    const responseBlob = new Blob([content], { type: "text/plain" })
    return responseBlob;
}

/**
 * Processes a submission from the fractional form. Checks the validity of the form,
 * parses the resume uploaded, finds the parsed record, updates any extra details,
 * adds the form response as an attachment. (All in TopEchelon).
 * @param {string} accessToken 
 * @param {FormData} formData 
 * @returns {Object} Status object with the submissionID, status and accompanying message.
 */
export async function fractionalSubmission(accessToken, formData){
    const submissionID = uid();
    const statusObject = {
        "id": submissionID,
        "status": 500,
        "message": "Submission Incomplete"
    }
    console.log(`Processing fractional form submission: ${submissionID}`)

    // Check that the form is formatted correctly
    const formCheck = checkFormSubmission(formData, true)
    if (formCheck["status"] !== 200){
        statusObject["status"] = formCheck["status"];
        statusObject["message"] = formCheck["message"]
        return statusObject
    }
    console.log("Form checked")

    // Parse a new record from the resume file
    const resumeFile = formData.get("resume")
    console.log(`${submissionID}: Parsing resume`)

    const resParseResume = await parseFromResumeTE(accessToken, resumeFile)
    if (resParseResume !== 201){
        statusObject["status"] = resParseResume;
        statusObject["message"] = "Parse error"
        return statusObject
    }

    // Find the record that was just created
    const searchFilter = {
        "keyword": `${formData.get("fname")} ${formData.get("lname")}`,
        "minimum_date_modified": getDateString(new Date(Date.now())),
    }
    console.log(`${submissionID}: Locating record`)

    const resPersonSearch = await findRecordTE(accessToken, searchFilter)
    if (resPersonSearch !== 200){
        statusObject["status"] = resParseResume["status"];
        statusObject["message"] = "Search error"
        return statusObject
    }
    const personRecord = resPersonSearch["result"]
    const personId = personRecord["id"]

    // Update the record with extra details
    console.log(`${submissionID}: Updating person`)
    // Create the update body
    const updateBody = {
        "first_name": formData.get("fname"),
        "last_name": formData.get("lname"),
        "linked_in": formData.get("linkedIn"),
        "city": formData.get("city"),
        "state": formData.get("state"),
        "country": formData.get("country"), 
        "work_history_update": {
            "title": formData.get("jobTitle"),
            "description": formData.get("responsibilities"),
            "company_name": formData.get("company"),
            "is_present_job": true
        },
        "sourced_from": "Website - Fractional Form"
    }
    // Check if the email field is already in the record
    const submissionEmail = formData.get("email")
    const recordEmails = personRecord["email_addresses"]
    var recordHasEmail = false;
    for (var email of recordEmails){
        if (email["email"].valueOf() == submissionEmail.valueOf()){
            recordHasEmail = true
            break
        }
    }
    if (!recordHasEmail){
        updateBody["email_addresses_attributes"] = [{
            "primary": true,
            "type": "work",
            "email": formData.get("email"),
            "do_not_email": false
        }]
    }
    // Attempt to push the updates
    const resPersonUpdate = await updateRecordTE(accessToken, personId, updateBody)
    if (resPersonUpdate !== 200){
        statusObject["status"] = resPersonUpdate;
        statusObject["message"] = "Update error"
        return statusObject
    }

    // Create an attachment with form response
    console.log(`${submissionID}: Adding attachment`)
    const responseFile = createResponseFile(formData)
    const resAttachment = await addAttachmentTE(accessToken, personId, responseFile, "responses.txt")
    if (resAttachment !== 201){
        statusObject["status"] = resAttachment;
        statusObject["message"] = "Attachment error";
        return statusObject
    }

    // Add to the fractional work hotlist
    console.log(`${submissionID}: Adding to fractional hotlist`)
    const hotlistRes = await addToHotlistTE(accessToken, "fractional", [personId])
    if (hotlistRes["status"] !== 200){
        statusObject["status"] = hotlistRes["status"];
        statusObject["message"] = hotlistRes["message"];
        return statusObject
    }

    // If all stages are completed successfully return 200 code
    statusObject["status"] = 200;
    statusObject["message"] = "Person record created successfully";
    return statusObject
}