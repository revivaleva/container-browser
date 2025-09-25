import boto3,hashlib
def handler(event,context):
    s3 = boto3.client('s3')
    bucket = event['bucket']
    key = event['key']
    obj = s3.get_object(Bucket=bucket, Key=key)
    data = obj['Body'].read()
    h = hashlib.sha256(data).hexdigest()
    return {'sha256':h, 'etag': obj.get('ETag'), 'content_length': obj.get('ContentLength')}
