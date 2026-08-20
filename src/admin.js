/**
 * Admin actions
 * 
 * A collections of admin functions for manipulating the data in 3rd party databases.
 * DB: Top Echelon, Notion
 * 
 * env vars required: None
 */

import { retryTimer } from "./utilities.js";

/**
 * Creates a dictionary of duplicate people records on Top Echelon.
 * @param {string} accessToken 
 * @returns {Object} status object containing a `"duplicates"` field on success
 */
export async function findDuplicatesTE(accessToken) {
    const seen = new Map();
    var totalPages = 1;
    var currentPage = 1;
    var retries = 0;
    // Iterate over each paginated page of results to collect all records
    while (currentPage <= totalPages){
        // After 3 retries throw an error
        if (retries > 3){
            console.error("Too many retries")
            return false
        }
        const resPeopleSearch = await fetch("https://bb3api.topechelon.com/public/v1/people/search", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "page": currentPage,
                "sort_by": "date_modified",
                "sort_order": "asc",
                "person_search": {
                    "keyword": ""
                }
            })
        })
        //console.log(`Response: ${currentPage}/${totalPages} ${resPeopleSearch.status} ${resPeopleSearch.statusText}`)
        // Handle response errors
        if (resPeopleSearch.status === 429) {
            retries += 1;
            const retryAfterHeader = resPeopleSearch.headers.get("Retry-After");
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
        } else if (resPeopleSearch.status === 401) {
            console.error("Authentication error")
            return {
                "status": 401,
                "message": "Authentication error"
            }
        } else if (resPeopleSearch.status != 200) {
            // By default retry after 5 seconds
            retries += 1
            await retryTimer(5);
            continue;
        }

        const object = await resPeopleSearch.json()
        const pagination = object["pagination"];
        const entries = object["entries"];

        for (var person of entries){
            const key = person["name"]
            const id = person["id"]
            // Create a new key if the name hasn't been seen before
            if (!seen.has(key)) {
                seen.set(key, []);
            }
            seen.get(key).push(id);
        }
        // Move onto the next page
        totalPages = pagination["total_pages"];
        currentPage = pagination["current_page"] + 1;
        retries = 0
    }
    
    // Filter for keys with more than one ID
    const duplicates = new Map(
        [...seen].filter(([, values]) => values.length > 1)
    );
    return {
        "status": 200,
        "message": "Success",
        "duplicates": duplicates
    };
}

/**
 * Searches for a hotlist by name and creates it if not found.
 * @param {string} accessToken 
 * @param {string} hotlist 
 * @returns {string} The id of the hotlist.
 */
async function getHotlistID(accessToken, hotlist){
    // Check if the desired hotlist exists
    const resHotlistSearch = await fetch(`https://bb3api.topechelon.com/public/v1/hotlists?record_type=person&name=${hotlist}&page=1`, {
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
        const resHotlistCreate = await fetch("https://bb3api.topechelon.com/public/v1/hotlists?record_type=person", {
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
        if (resHotlistCreate.status !== 200){
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
export async function addToHotlist(accessToken, hotlist, records){
    // Get the desired hotlist ID
    const hotlistID = await getHotlistID(accessToken, hotlist);
    if (!hotlist){
        return {
            "status": 500,
            "message": "Hotlist could not be found or created"
        }
    }

    // Add each record in the list to the hotlist
    for (let record of records){
        const resAddToHotlist = await fetch(`https://bb3api.topechelon.com/public/v1/hotlists/${hotlistID}/add_record?record_id=${record}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
            },
        })
        //console.log(`Add response: ${resAddToHotlist.status} ${resAddToHotlist.statusText}`)
        if (resAddToHotlist.status !== 200){
            console.error(`Failed to add record ${record} to hotlist ${hotlist}`)
        }
    }

    return {
        "status": 200,
        "message": "Added to hotlist successfully"
    }
}