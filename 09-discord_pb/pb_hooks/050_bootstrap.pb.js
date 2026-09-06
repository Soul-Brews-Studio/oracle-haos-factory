/// <reference path="../pb_data/types.d.ts" />
onBootstrap((e) => {
  e.next()
  const superusers = e.app.findCollectionByNameOrId("_superusers")
  if (superusers.authToken.duration !== 300) {
    superusers.authToken.duration = 300
    e.app.save(superusers)
  }
  const email = $os.getenv("DISCORD_PB_ADMIN_EMAIL")
  const password = $os.getenv("DISCORD_PB_ADMIN_PASSWORD")
  if (!email || !password) throw new Error("bootstrap credentials are required")
  const matches = e.app.findRecordsByFilter("_superusers", "email = {:email}", "", 1, 0, { email })
  if (!matches.length || $os.getenv("DISCORD_PB_SET_PASSWORD") === "true") {
    const record = matches.length ? matches[0] : new Record(e.app.findCollectionByNameOrId("_superusers"))
    record.set("email", email)
    record.setPassword(password)
    e.app.save(record)
  }
})
