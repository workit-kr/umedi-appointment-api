import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: 5432,
});
await pool.connect();


var key = process.env.ENCRYPTION_KEY;

export const handler = async (event) => {
    let resp = {};
  
    switch (event.httpMethod) {
      // get appointments
      case "GET":
        
        const path = event.resource

        if (path == '/appointment') {
          resp = fetchAppointmentList()
        }
        break;
      
      // add appointments
      case "PUT":
        resp = addAppointment(JSON.parse(event.body))
        break;
      
      // upload images
      case "POST":
        resp = buildResponse(200, {"message": "GET method"});
        break;
      
      default:
        resp = buildResponse(400, {"message": "bad request"});
        break;
    }
  
    return resp
  }
  
  async function fetchAppointmentList() {
    let query = `
      select
        appointment_id,
        hospital_id,
        speciality,
        first_name,
        last_name,
        phone,
        email,
        gender,
        date_of_birth,
        claim_yn,
        to_char(candidate_dt1 at time zone 'Asia/Seoul', 'YYYY-MM-DD AM HH12:MI') as candidate_dt1,
        to_char(candidate_dt2 at time zone 'Asia/Seoul', 'YYYY-MM-DD AM HH12:MI') as candidate_dt2,
        to_char(crtn_dt at time zone 'Asia/Seoul', 'YYYY-MM-DD AM HH12:MI') as crtn_dt
      from
        umedi.appointment`;
    const result = await execute_query(query, null, false)
    return result
  }

  async function addAppointment(r) {
    let updateQuery = `
      update umedi.sequences
      set id = id + 1
      returning id
    `;

    const updateResult = await execute_query(updateQuery, null, true)
    const id = updateResult[0].id.toString()

    let params = []
    let query = `
      insert into umedi.appointment
        (appointment_id, hospital_id, speciality, first_name, last_name, phone, email, gender, date_of_birth, claim_yn, candidate_dt1, candidate_dt2)
      values
        (
          $1, $2, $3, $4, $5,
          encode(encrypt(convert_to($6, 'utf8'), $7, 'aes'), 'base64'),
          $8, $9, $10, $11,
          to_timestamp($12, 'YYYY-MM-DD AM HH12:MI')::timestamp at time zone 'Asia/Seoul',
          to_timestamp($13, 'YYYY-MM-DD AM HH12:MI')::timestamp at time zone 'Asia/Seoul'
        )
    `;

    if (r.candidate_dt.length == 0 || r.candidate_dt.length > 2) {
      return buildResponse(400, {"message": "invalid datetime"})
    }

    if (r.user.claim_yn == 'y') { // claim 하는 경우
      params = [
        id, r.hospital_id, r.speciality,
        r.user.first_name, r.user.last_name, r.user.phone, key,
        r.user.email, r.user.gender, r.user.date_of_birth, r.user.claim_yn,
        r.candidate_dt[0], r.candidate_dt[1] ? r.candidate_dt[1] : null
      ]
    } else {
      params = [
        id, r.hospital_id, r.speciality,
        r.user.first_name, r.user.last_name, r.user.phone, key,
        r.user.email, null, null, r.user.claim_yn,
        r.candidate_dt[0], r.candidate_dt[1] ? r.candidate_dt[1] : null
      ]
    }

    const result = await execute_query(query, params, false);
    let resp = {};
    if (result.statusCode == 200) {
      resp = buildResponse(200, {"appointment_id": id});
    } else {
      resp = result
    }
    return resp
  }

  async function execute_query(query, params, raw) {
    let result = {}

    try {
      if (params == null) {
        result = await pool.query(query);
      } else {
        result = await pool.query(query, params);
      }

      if (raw) {
        return result.rows
      }
  
      if (result.rowCount == 0) {
        return buildResponse(404, {"message": "no items"})
      };
  
      return buildResponse(200, result.rows)
    }
    catch (error) {
      console.error('server error');
      console.error(error)
      return buildResponse(500, {"message": "server error"})
    }
  }
  
  function buildResponse(statusCode, respBody) {
    return {
      statusCode: statusCode,
      headers: {
        "Access-Control-Allow-Headers" : "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST,PUT,GET"
      },
      body: JSON.stringify(respBody)
    }
  }