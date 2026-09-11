export const CALIBRATION_ERROR_CODES = Object.freeze({
  INFRASTRUCTURE_DEADLINE: 'CALIBRATION_INFRASTRUCTURE_DEADLINE',
  INFRASTRUCTURE_AUTHORITY: 'CALIBRATION_INFRASTRUCTURE_AUTHORITY',
  AUTHORITY_AUTHORIZATION: 'CALIBRATION_AUTHORITY_AUTHORIZATION',
  AUTHORITY_PROTOCOL: 'CALIBRATION_AUTHORITY_PROTOCOL',
  IMPLEMENTATION_DEFECT: 'CALIBRATION_IMPLEMENTATION_DEFECT',
  PROTOCOL_VIOLATION: 'CALIBRATION_PROTOCOL_VIOLATION',
  BLINDING_BREACH: 'CALIBRATION_BLINDING_BREACH',
  RESEARCH_DESIGN_BLOCKER: 'CALIBRATION_RESEARCH_DESIGN_BLOCKER'
});

export class CalibrationExecutionError extends Error {
  constructor(code, classification, message, options = {}) {
    super(message, options);
    this.name = 'CalibrationExecutionError';
    this.code = code;
    this.calibrationClassification = classification;
  }
}

export const infrastructureDeadline = message => new CalibrationExecutionError(
  CALIBRATION_ERROR_CODES.INFRASTRUCTURE_DEADLINE, 'INFRASTRUCTURE_FAILURE', message);

export const infrastructureAuthority = message => new CalibrationExecutionError(
  CALIBRATION_ERROR_CODES.INFRASTRUCTURE_AUTHORITY, 'INFRASTRUCTURE_FAILURE', message);

export const authorityAuthorization = message => new CalibrationExecutionError(
  CALIBRATION_ERROR_CODES.AUTHORITY_AUTHORIZATION, 'PROTOCOL_VIOLATION', message);

export const authorityProtocol = message => new CalibrationExecutionError(
  CALIBRATION_ERROR_CODES.AUTHORITY_PROTOCOL, 'PROTOCOL_VIOLATION', message);

export const implementationDefect = message => new CalibrationExecutionError(
  CALIBRATION_ERROR_CODES.IMPLEMENTATION_DEFECT, 'IMPLEMENTATION_DEFECT', message);

export function calibrationFailureClassification(error, fallback = 'IMPLEMENTATION_DEFECT') {
  const classification = error?.calibrationClassification;
  return typeof classification === 'string' ? classification : fallback;
}
