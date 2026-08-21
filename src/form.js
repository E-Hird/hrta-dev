/**
 * Form Submission Handler
 * 
 * Checks form submissions from the website, validates and transforms the payload,
 * and uploads to the relevant 3rd party databases.
 * 
 * env vars required: None
 */

import { addToHotlist } from "./admin.js";
import { uid, retryTimer } from "./utilities.js";

/**
 * Parse a Date object to a string of format `YYYY-MM-DD`
 * @param {Date} date
 * @returns The a string in format YYYY-MM-DD
 */
function getDateString(date){
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth()).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * Checks if the contents of the form fits requirements.
 * @param {FormData} formData 
 * @param {Boolean} fractional - default=false
 * @returns {Object} the status and a status message of the check
 */
function checkFormSubmission(formData, fractional=false){
    // List of fields that should be present in the formData
    const fields = ["fname", "lname", "email", "linkedIn", "resume", "location", "jobTitle", "industry", "company",
        "boss", "responsibilities", "teamsAndFunctions", "challengesSolved", "fixBuildImprove", "outcomes", "problemSolving",
        "keySystems", "workInterest", "companyInterest", "workTypePreference",
    ]
    var status = 200;
    // Check if any fields are missing
    var missingFieldString = ""
    for (let field of fields){
        if (!formData.has(field)){
            status = 400;
            missingFieldString.concat(`${field}, `)
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
    Location: ${formData.get("location")}
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

    // Package the file into FormData for POST
    const deliveryForm = new FormData();
    deliveryForm.append('file', responseBlob, "responses.txt")
    return deliveryForm;
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
    const fileForm = new FormData();
    fileForm.append("file", resumeFile, resumeFile.name)

    console.log(`${submissionID}: Parsing resume`)
    const resParseResume = await fetch("https://bb3api.topechelon.com/public/v1/people/parse", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: fileForm
    })
    // console.log(`Parse response: ${resParseResume.status} ${resParseResume.statusText}`)
    if (resParseResume.status !== 201){
        statusObject["status"] = resParseResume.status;
        statusObject["message"] = "Parse error"
        return statusObject
    }

    
    // Find the record that was just created
    var foundRecord = false;
    var retries = 0;
    var searchResults = null;
    console.log(`${submissionID}: Locating record`)
    // Locating the record may take multiple attempts
    while (!foundRecord){
        // If the record isn't found after 3 reties then return an error
        if (retries > 3){
            console.error(`${submissionID}: Too many retries`)
            statusObject["status"] = 404;
            statusObject["message"] = "Person record not found";
            return statusObject
        }
        // Wait for the parsing process to finish
        const timer = retryTimer(1);
        // If timer is created wait for it to expire
        if (timer) {
            await timer;
        } else {
            console.error(`${submissionID}:  Retry timer broken or too long.`)
            statusObject["status"] = 500;
            statusObject["message"] = "Retry timer broken or too long";
            return statusObject
        }
        const resPersonSearch = await fetch("https://bb3api.topechelon.com/public/v1/people/search", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "page": 1,
                "sort_by": "date_added",
                "sort_order": "desc",
                "person_search": {
                    "keyword": `${formData.get("fname")} ${formData.get("lname")}`,
                    "minimum_date_modified": getDateString(new Date(Date.now())),
                }
            })
        })
        // console.log(`Search response: ${resPersonSearch.status} ${resPersonSearch.statusText}`)
        if (resPersonSearch.status !== 200){
            statusObject["status"] = resPersonSearch.status;
            statusObject["message"] = "Search error"
            return statusObject
        }

        searchResults = await resPersonSearch.json()
        if (searchResults["pagination"]["total_count"] <= 0){
            retries += 1
            continue
        }
        foundRecord = true;
    }
    const personRecord = searchResults["entries"][0]
    const personId = personRecord["id"]

    // Update the record with extra details
    console.log(`${submissionID}: Updating person`)
    // Create the update body
    const updateBody = {
        "first_name": formData.get("fname"),
        "last_name": formData.get("lname"),
        "linked_in": formData.get("linkedIn"),
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
    const resPersonUpdate = await fetch(`https://bb3api.topechelon.com/public/v1/people/${personId}`, {
        method: "PUT",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            "person": updateBody
        })
    })
    // console.log(`Update response: ${resPersonUpdate.status} ${resPersonUpdate.statusText}`)
    if (resPersonUpdate.status !== 200){
        statusObject["status"] = resPersonUpdate.status;
        statusObject["message"] = "Update error"
        return statusObject
    }

    // Create an attachment with form response
    console.log(`${submissionID}: Adding attachment`)
    const resAttachment = await fetch(`https://bb3api.topechelon.com/public/v1/people/${personId}/attachments`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: createResponseFile(formData)
    })
    // console.log(`Attachment response: ${resAttachment.status} ${resAttachment.statusText}`)
    if (resAttachment.status !== 201){
        statusObject["status"] = resAttachment.status;
        statusObject["message"] = "Attachment error";
        return statusObject
    }

    // Add to the fractional work hotlist
    console.log(`${submissionID}: Adding to fractional hotlist`)
    const hotlistRes = await addToHotlist(accessToken, "fractional", [personId])
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