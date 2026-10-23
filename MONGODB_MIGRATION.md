# Move AquaOS to MongoDB

Opened by DevX Control after the data was copied into **cluster2 / aquaos**.

## What changed
- .env.example: added MONGO_URI with a MongoDB placeholder.

## Needs a person
- Nothing flagged automatically.
- [ ] Look through any code that treats ids as numbers (parseInt of an id, z.number() ids).
- [ ] Run the tests and click through the app against a MongoDB database before merging.

## Check run by DevX Control
- No schema check was needed.

## Deploying
1. Put the real connection string in the server's `.env` as `MONGO_URI` (never commit it).
2. After this is merged, press **Switch to MongoDB** on the app in DevX Control. It copies the latest data, points the app at MongoDB, deploys, runs its checks, and only then offers to remove the old database.

This pull request was merged automatically by DevX Control because every check passed and nothing needed a person.
