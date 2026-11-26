# Phone number convention

Every phone number is stored and sent in one form: `+`, the country calling code, then the number, with no spaces or other characters. For example `+919876543210`. This is the E.164 form.

- **Where it applies:** Signals (`user.phone_number`, item phone fields), the aggregator database, Keycloak's `phoneNumber` attribute, and everything one service sends another.
- **Which numbers are accepted:** each deployment lists its countries in `PHONE_COUNTRIES`, for example `IN:+91,DK:+45`. A number is checked against its own country's rules (length, and mobile or not) with libphonenumber. A number typed without a calling code is read as the first country in the list.
- **What people may type:** spaces, dashes, brackets, a leading `0` or `00`. The apps clean the input before they check it and store only the E.164 form.
- **What the schemas check:** every phone `pattern` in `network.json` and the aggregator form schemas is `^\+[1-9][0-9]{9,14}$`. The pattern only checks the shape; the country rules are checked by the apps.

`phone-cases.json` in this directory holds the shared test cases. aggregator-dpg and signals-dpg keep a copy each and their CI fails when it differs from this file.

Data stored before this convention is converted with the `phone-normalise` scripts in Blue-Dots-Economy/adhoc-scripts.
