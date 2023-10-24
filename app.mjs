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
        console.log(result)

        if (result.statusCode == 200) {
          console.log("invoke subtask lambda")
          await lambda.invoke({
            FunctionName: process.env.SUBTASK,
            InvocationType: 'Event',
            LogType: 'Tail',
            Payload: JSON.stringify(result.data)
          }).promise()
        }
        resp = buildResponse(result.statusCode, {appointment_id: result.data.appointment_id})
        console.log(resp)
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
        (appointment_id, hospital_id, speciality, first_name, last_name, phone, email, gender, date_of_birth, claim_yn, candidate_dt1, candidate_dt2, additional_info)
      values
        (
          $1, $2, $3, $4, $5,
          encode(encrypt(convert_to($6, 'utf8'), $7, 'aes'), 'base64'), $8, $9,
          encode(encrypt(convert_to($10, 'utf8'), $7, 'aes'), 'base64'), $11,
          to_timestamp($12, 'YYYY-MM-DD AM HH12:MI')::timestamp at time zone 'Asia/Seoul',
          to_timestamp($13, 'YYYY-MM-DD AM HH12:MI')::timestamp at time zone 'Asia/Seoul',
          $14
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
        r.candidate_dt[0], r.candidate_dt[1] ? r.candidate_dt[1] : null,
        r.user.additional_info
      ]
    } else {
      params = [
        id, r.hospital_id, r.speciality,
        r.user.first_name, r.user.last_name, r.user.phone, key,
        r.user.email, null, null, r.user.claim_yn,
        r.candidate_dt[0], r.candidate_dt[1] ? r.candidate_dt[1] : null,
        r.user.additional_info
      ]
    }

    const result = await execute_query(query, params, false);

    const booking_query = `
      select
          s.name as speciality,
          h.name as hospital
      from
          hospital h,
          speciality s
      where
          (h.speciality_1 = s.code or h.speciality_2 = s.code)
          and s.code = '${r.speciality}'
          and h.id = ${r.hospital_id}
    `
    const booking_info = await execute_query(booking_query, null, true);
    console.log(booking_query)
    console.log(booking_info)

    if (result.statusCode == 200) {
      return {
        statusCode: 200,
        data: {
          appointment_id: id,
          hospital: booking_info[0].hospital,
          speciality: booking_info[0].speciality,
          first_name: r.user.first_name,
          last_name: r.user.last_name,
          phone: r.user.phone,
          email: r.user.email,
          candidate_dt1: r.candidate_dt[0],
          candidate_dt2: r.candidate_dt[1] ? r.candidate_dt[1] : "",
          claim_yn: r.user.claim_yn,
          gender: r.user.gender ? r.user.gender : "",
          date_of_birth: r.user.date_of_birth ? r.user.date_of_birth : "",
          additional_info: r.user.additional_info,
          insurance_imgs: r.user.insurance_imgs,
          additional_imgs: r.user.additional_imgs
        }
      }
    }
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
          data: {"message": "no result"}
        }
      };
  
      return {
        statusCode: 200,
        data: result.rows
      }
    }
    catch (error) {
      console.error('server error');
      console.error(error)
      return {
        statusCode: 500,
        data: {"message": "server error"}
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