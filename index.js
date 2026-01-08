(async () => {
    try {
        const test = await base(AIRTABLE_TABLE).select({ maxRecords: 1 }).firstPage();
        console.log("AIRTABLE OK", test.length);
    } catch (e) {
        console.error("AIRTABLE ERROR", e);
        process.exit(1);
    }
})();


