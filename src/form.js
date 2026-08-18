/**
 * Form Submission Handler
 * 
 * Checks form submissions from the website, validates and transforms the payload,
 * and uploads to the relevant 3rd party databases.
 * 
 * env vars required: None
 */

import { retryTimer } from "./utilities";

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

    // Check that the linkedin link is for linkedin
    const linkedInProfile = formData.get("linkedIn");
    if (!linkedInProfile.includes("www.linkedin.com/in/")){
        return {
            "status": 400,
            "message": "Link to LinkedIn profile is malformed"
        }
    }

    // Check that work preference is one of the given options
    const options = ["On site/In office", "Hybrid", "Remote"]
    if (!(formData.get("workTypePreference") in options)){
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
    // const formCheck = checkFormSubmission(formData, true)
    // if (formCheck["status"] !== 200){
    //     console.log(JSON.stringify(formCheck))
    //     return {
    //         "status": formCheck["status"],
    //         "message": "Error"
    //     }
    // }
    console.log("Form checked")
    // Parse a new record from the resume file
    const resumeFile = formData.get("resume")
    const fileForm = new FormData();
    fileForm.append("file", resumeFile, resumeFile.name)

    console.log("Parsing resume")
    console.log(`Using token: ${accessToken}`)
    const resParseResume = await fetch("https://bb3api.topechelon.com/public/v1/people/parse", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: fileForm
    })
    console.log(`Parse response: ${resParseResume.status} ${resParseResume.statusText}`)
    if (resParseResume.status !== 201){
        return {
            "status": resParseResume.status,
            "message": "Parse error"
        }
    }

    
    // Find the record that was just created
    var foundRecord = false;
    var retries = 0;
    var searchResults = null;
    while (!foundRecord){
        if (retries > 3){
            console.error("Too many retries")
            return {
                "status": 404,
                "message": "Person record not found"
            }
        }
        const timer = retryTimer(0);
        // If timer is created return
        if (timer) {
            await timer;
        } else {
            console.error("Retry timer broken or too long.")
            return {
                "status": 500,
                "message": "Retry timer broken or too long"
            }
        }
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
        if (resPersonSearch.status !== 200){
            return {
                "status": resPersonSearch.status,
                "message": "Search error"
            }
        }

        searchResults = await resPersonSearch.json()
        console.log(searchResults)
        if (searchResults["pagination"]["total_count"] <= 0){
            retries += 1
            continue
        }
        foundRecord = true;
    }
    const personId = searchResults["entries"][0]["id"]
    console.log("Created record with id:", personId)

    // Update the record with extra details
    console.log("Updating person")
    try{
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
        console.log(`Update body: ${resPersonUpdate.body}`)
    } catch(err){
        console.error("Fetch threw:", err.message, err.cause)
    }
    if (resPersonUpdate.status !== 200){
        return {
            "status": resPersonUpdate.status,
            "message": "Update error"
        }
    }

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
    if (resAttachment.status !== 201){
        return {
            "status": resAttachment.status,
            "message": "Attachment error"
        }
    }

    return {
        "status": 200,
        "message": "All good"
    }
}