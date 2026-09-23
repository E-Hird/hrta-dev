/**
 * Database Actions
 * 
 * Includes functions for interacting with the HRTA databases (Top Echelon and Notion).
 * Functions that are for Top Echelon end TE and functions for Notion end in N.
 * List of the functionalities included are:
 *      Top Echelon: 
 *          # Hotlist: Getting Hotlist ID, Adding records to a Hotlist, Getting hotlist records
 *          # Person Records: Searching for a Person Record, Parsing a resume to create/update a person record, 
 *              Updating a person record, Adding attachments to a person record
 * 
 * env vars required: None       
 */

import { retryTimer } from "./utilities.js";

// ========================================================Top Echelon=========================================================

// # Hotlists

/**
 * Searches for a hotlist by name and creates it if not found.
 * @param {string} accessToken 
 * @param {string} hotlist 
 * @returns {string} The id of the hotlist.
 */
async function getHotlistIdTE(accessToken, hotlist, type="person"){
    // Check if the desired hotlist exists
    const resHotlistSearch = await fetch(`https://bb3api.topechelon.com/public/v1/hotlists?record_type=${type}&name=${hotlist}&page=1`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${accessToken}` }
    })
    //console.log(`Hotlist search response: ${resHotlistSearch.status} ${resHotlistSearch.statusText}`)
    if (resHotlistSearch.status !== 200){
        console.error(`Hotlist ${hotlist} could not be searched.`)
        return false
    }
    const searchResults = await resHotlistSearch.json()

    const metadata = searchResults["metadata"]["resultset"]
    if (metadata["count"] > 0){
        return searchResults["results"][0]["id"]
    } else {
        // Create the hotlist if it doesn't exist
        const resHotlistCreate = await fetch(`https://bb3api.topechelon.com/public/v1/hotlists?record_type=${type}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "hotlist": {
                    "name": hotlist,
                    "share_with_agency": true
                }
            })
        })
        //console.log(`Hotlist create response: ${resHotlistCreate.status} ${resHotlistCreate.statusText}`)
        if (resHotlistCreate.status !== 201){
            console.error(`Hotlist ${hotlist} could not be created.`)
            return false
        }
        const createdHotlist = await resHotlistCreate.json()
        return createdHotlist["hotlist"]["id"]
    }
}

/**
 * Adds a list of records to a desired hotlist
 * @param {string} accessToken 
 * @param {string} hotlist 
 * @param {Array} records 
 * @returns {Object} A status object containing a status and message
 */
export async function addToHotlistTE(accessToken, hotlist, records, type="person"){
    // Get the desired hotlist ID
    const hotlistID = await getHotlistIdTE(accessToken, hotlist, type);
    if (!hotlistID){
        return {
            "status": 500,
            "message": "Hotlist could not be found or created"
        }
    }


    var totalRecords = records.length;
    var currentRecord = 0;
    var retries = 0;
    // Iterate over each paginated page of results to collect all records
    while (currentRecord < totalRecords){
        // After 3 retries throw an error
        if (retries > 3){
            console.error("Too many retries")
            console.error(`Failed to add record ${record} to hotlist ${hotlist}`)
            // Move onto the next record
            currentRecord += 1;
            retries = 0;
            continue;
        }
        const record = records[currentRecord]
        const resAddToHotlist = await fetch(`https://bb3api.topechelon.com/public/v1/hotlists/${hotlistID}/add_record?record_id=${record}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
            },
        })
        //console.log(`Response: ${currentPage}/${totalPages} ${resAddToHotlist.status} ${resAddToHotlist.statusText}`)
        // Handle response errors
        if (resAddToHotlist.status === 429) {
            retries += 1;
            const retryAfterHeader = resAddToHotlist.headers.get("Retry-After");
            const timer = retryTimer(retryAfterHeader);
            // If timer is created return
            if (timer) {
                await timer;
            } else {
                console.error("Retry timer broken or too long.")
                return {
                    "status": 429,
                    "message": "Retry timer broken or too long"
                }
            }
            continue;
        } else if (resAddToHotlist.status === 401) {
            console.error("Authentication error")
            return {
                "status": 401,
                "message": "Authentication error"
            }
        } else if (resAddToHotlist.status != 200) {
            // By default retry after 5 seconds
            retries += 1
            await retryTimer(5);
            continue;
        }

        // Move onto the next record
        currentRecord += 1;
        retries = 0
    }

    return {
        "status": 200,
        "message": "Added to hotlist successfully"
    }
}

/**
 * Gets all records belonging to a desired hotlist
 * @param {string} accessToken 
 * @param {string} hotlist 
 * @param {string} type 
 * @returns {Object} A status object containing the results in `"results"`
 */
export async function getHotlistRecordsTE(accessToken, hotlist, type="person"){
    // Get the desired hotlist ID
    const hotlistID = await getHotlistIdTE(accessToken, hotlist, type);
    if (!hotlistID){
        return {
            "status": 500,
            "message": "Hotlist could not be found or created"
        }
    }

    // Get the records for the hotlist
    const resGetHotlistRecords = await fetch(`https://bb3api.topechelon.com/public/v1/${hotlistID}/all_records`, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${accessToken}`
        }
    })
    // Error if the records can't be collected
    if (resGetHotlistRecords.status !== 200){
        return {
            "status": resGetHotlistRecords.status,
            "message": "Failed to collect Hotlist records"
        }
    }
    // Error if there aren't any records in the hotlist
    const results = await resGetHotlistRecords.json()["entries"]
    if (results.length <= 0){
        return {
            "status": 404,
            "message": "Hotlist contains no records"
        }
    }
    // Return the records if successfully found
    return {
        "status": 200,
        "message": "Found Hotlist records",
        "results": results
    }
}

// # Person Records

/**
 * Creates/updates a record in Top Echelon from a candidate resume.
 * @param {string} accessToken 
 * @param {File} resumeFile 
 * @returns Status of the API request
 */
export async function parseFromResumeTE(accessToken, resumeFile){
    const fileForm = new FormData();
    fileForm.append("file", resumeFile, resumeFile.name)

    const resParseResume = await fetch("https://bb3api.topechelon.com/public/v1/people/parse", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: fileForm
    })
    // console.log(`Parse response: ${resParseResume.status} ${resParseResume.statusText}`)
    return resParseResume.status;
}

/**
 * Locates a Top Echelon Record matching a `person_search` body
 * @param {string} accessToken 
 * @param {Object} searchFilters 
 * @param {string} sort_by 
 * @param {string} sort_order 
 * @returns {Object} status object containing the located record.
 */
export async function findRecordTE(accessToken, searchFilters, sort_by="date_added", sort_order="desc"){
    const statusObject = {
        "status": 500,
        "message": "Search Incomplete",
        "result": null
    }
    var foundRecord = false;
    var retries = 0;
    var searchResults = null;
    // Locating the record may take multiple attempts
    while (!foundRecord){
        // If the record isn't found after 3 reties then return an error
        if (retries > 3){
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
                "sort_by": sort_by,
                "sort_order": sort_order,
                "person_search": searchFilters
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
    statusObject["status"] = 200;
    statusObject["message"] = "Person record found";
    statusObject["result"] = searchResults["entries"][0];
    return statusObject
}

/**
 * Update the details of a record with ID `personId`.
 * @param {string} accessToken 
 * @param {string} personId
 * @param {Object} updateBody 
 * @returns Status of the API request
 */
export async function updateRecordTE(accessToken, personId, updateBody){
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
    return resPersonUpdate.status
}

/**
 * Attaches the file `attachmentFile` to the Top Echelon record associated with `personId`
 * @param {string} accessToken 
 * @param {string} personId 
 * @param {File} attachmentFile 
 * @param {string} attachmentName 
 * @returns Status of the API request
 */
export async function addAttachmentTE(accessToken, personId, attachmentFile, attachmentName){
    // Package the file into FormData for POST
    const deliveryForm = new FormData();
    deliveryForm.append('file', attachmentFile, attachmentName)
    const resAttachment = await fetch(`https://bb3api.topechelon.com/public/v1/people/${personId}/attachments`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
        body: deliveryForm
    })
    // console.log(`Attachment response: ${resAttachment.status} ${resAttachment.statusText}`)
    return resAttachment.status;
}


// ===========================================================Notion===========================================================

/**
 * Get a list of the names of the Notion databases currently being tracked
 * @param {Object} env 
 * @returns A list of names of databases currently being tracked
 */
export async function getTrackedDatabasesN(env){
    return await env.DATABASE_IDS.list();
}

/**
 * Add or update a key to contain the ID for a different Database
 * @param {Object} env 
 * @param {string} key 
 * @param {string} id 
 * @returns `true` on success
 */
export async function trackNewDatabaseN(env, key, id){
    await env.DATABASE_IDS.put(key, id);
    return true
}

/**
 * Get the ID of the database stored under `key`
 * @param {Object} env 
 * @param {string} key 
 * @returns The ID of the requested database 
 */
export async function getDatabaseIdN(env, key){
    const id = await env.DATABASE_IDS.get(key)
    if (id){
        return id
    } else {
        return false
    }
}