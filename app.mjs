import pg from "pg";
import aws from "aws-sdk";
import bluebird from "bluebird";


aws.config.setPromisesDependency(bluebird);


const { Pool } = pg;
const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: 5432,
});
await pool.connect();

const key = process.env.ENCRYPTION_KEY;
const lambda = new aws.Lambda({
  region: 'ap-northeast-2'
})


export const handler = async (event) => {
    let resp = {};
    let result = {};
  
    switch (event.httpMethod) {
      // get appointments
      case "GET":
        result = fetchAppointmentList();
        resp = buildResponse(result.statusCode, result.data);
        break;
      
      // add appointments
      case "PUT":
        const body = JSON.parse(event.body)
        result = await addAppointment(body)
        console.log(resp)

        if (resp.statusCode == 200) {
          console.log("invoke subtask lambda")
          console.log(JSON.parse(resp.body))

          await lambda.invoke({
            FunctionName: 'umedi-subtask',
            InvocationType: 'Event',
            LogType: 'Tail',
            Payload: JSON.stringify({
              appointment_id: result.data.appointment_id
            })
            // Payload: JSON.stringify({
            //     appointment_id: resp.body.appointment_id,
            //     insurance_imgs: body.insurance_imgs,
            //     additional_imgs: body.additional_imgs
            // })
          }).promise()
        }
        resp = buildResponse(result.statusCode, result.data)
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
        decrypt(decode(phone, 'base64'), $1, 'aes'),
        email,
        gender,
        decrypt(decode(date_of_birth, 'base64'), $1, 'aes'),
        claim_yn,
        to_char(candidate_dt1 at time zone 'Asia/Seoul', 'YYYY-MM-DD AM HH12:MI') as candidate_dt1,
        to_char(candidate_dt2 at time zone 'Asia/Seoul', 'YYYY-MM-DD AM HH12:MI') as candidate_dt2,
        to_char(crtn_dt at time zone 'Asia/Seoul', 'YYYY-MM-DD AM HH12:MI') as crtn_dt
      from
        umedi.appointment`;
      
    const params = [key];
    const result = await execute_query(query, params, false);
    return result
  }

  async function addAppointment(r) {
    let updateQuery = `
      update umedi.sequences
      set id = id + 1
      returning id
    `;

    const updateResult = await execute_query(updateQuery, null, true);
    const id = updateResult[0].id.toString();

    let params = [];
    let query = `
      insert into umedi.appointment
        (appointment_id, hospital_id, speciality, first_name, last_name, phone, email, gender, date_of_birth, claim_yn, candidate_dt1, candidate_dt2)
      values
        (
          $1, $2, $3, $4, $5,
          encode(encrypt(convert_to($6, 'utf8'), $7, 'aes'), 'base64'), $8, $9,
          encode(encrypt(convert_to($10, 'utf8'), $7, 'aes'), 'base64'), $11,
          to_timestamp($12, 'YYYY-MM-DD AM HH12:MI')::timestamp at time zone 'Asia/Seoul',
          to_timestamp($13, 'YYYY-MM-DD AM HH12:MI')::timestamp at time zone 'Asia/Seoul'
        )
    `;

    if (r.candidate_dt.length == 0 || r.candidate_dt.length > 2) {
      return buildResponse(400, {"message": "invalid datetime"})
    };

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
    return result
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
        return {
          statusCode: 404,
          message: {"message": "no result"}
        }
      };
  
      return {
        statusCode: 200,
        message: {"data": result.rows}
      }
    }
    catch (error) {
      console.error('server error');
      console.error(error)
      return {
        statusCode: 500,
        message: {"message": "server error"}
      }
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