package codextransport

func AdaptChat(body []byte) ([]byte, error) {
	adapted, err := PrepareChat(body)
	if err != nil {
		return nil, err
	}
	return adapted.Body, nil
}
