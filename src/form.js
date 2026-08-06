/**
 * Form Submission Handler
 * 
 * Checks form submissions from the website, validates and transforms the payload,
 * and uploads to the relevant 3rd party databases.
 * 
 * env vars required: None
 */

/**
 * Parse a Date object to a string of format `YYYY-MM-DD`
 * @param {*} date
 * @returns The a string in format YYYY-MM-DD
 */
function getDateString(date){
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth()).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * Checks if the contents of the form fits requirements.
 * @param {Object} formData 
 * @param {Boolean} fractional - default=false
 * @returns {Object} the status and a status message of the check
 */
function checkFormSubmission(formData, fractional=false){
    const message = "All good";
    return {
        "status": 200,
        "message": message
    }
}

/**
 * Creates a text file containing responses to form questions
 * @param {Object} formData 
 * @returns {FormData} Delivery form
 */
function createResponseFile(formData){
    const content = ```
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
    ```

    // Turn text into a file format
    const responseBlob = new Blob([content], { type: "text/plain" })

    // Package the file into FormData for POST
    const deliveryForm = new FormData();
    deliveryForm.append('file', responseBlob, "responses.txt")
    return deliveryForm;
}

export async function fractionalSubmission(accessToken, formData){
    console.log("Processing fractional form submission")
    // Check that the form is formatted correctly
    const formCheck = checkFormSubmission(formData, true)
    if (formCheck["status"] !== 200){
        console.log(JSON.stringify(formCheck))
        return {
            "status": formCheck["status"],
            "message": "Error"
        }
    }
    console.log("Form checked")
    // Parse a new record from the resume file
    const resumeFile = formData.get("resume")
    const fileForm = new FormData();
    fileForm.append("file", resumeFile, resumeFile.name)

    console.log("Parsing resume")
    const resParseResume = await fetch("https://bb3api.topechelon.com/public/v1/people/parse", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: fileForm
    })
    console.log(`Parse response: ${resParseResume.status} ${resParseResume.statusText}`)
    if (resParseResume.status !== 201){
        console.log(resParseResume.text)
    }

    // Find the record that was just created
    console.log("Searching for person")
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
                "minimum_date_entered": getDateString(new Date(Date.now())),
            }
        })
    })
    console.log(`Search response: ${resPersonSearch.status} ${resPersonSearch.statusText}`)

    const searchResults = await resPersonSearch.json()
    const personId = searchResults["entries"][0]["id"]
    console.log("Created record with id:", personId)

    // Update the record with extra details
    console.log("Updating person")
    const resPersonUpdate = await fetch(`https://bb3api.topechlon.com/public/v1/people/${personId}`, {
        method: "PUT",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            "person": {
                "first_name": formData.get("fname"),
                "last_name": formData.get("lname"),
                "linked_in": formData.get("linkedIn"),
                "email_addresses_attributes": [{
                    "primary": true,
                    "type": "work",
                    "email": formData.get("email"),
                    "do_not_email": false
                }]
            }
        })
    })
    console.log(`Update response: ${resPersonUpdate.status} ${resPersonUpdate.statusText}`)

    // Create an attachment with form response
    console.log("Adding attachment")
    const resAttachment = await fetch(`https://bb3api.topechlon.com/public/v1/people/${personId}/attachments`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: createResponseFile(formData)
    })
    console.log(`Attachment response: ${resAttachment.status} ${resAttachment.statusText}`)

    return {
        "status": 200,
        "message": "All good"
    }
}